import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";

export interface PanelData {
  name: string; // filename without extension
  html: string; // rendered HTML
}

/** Watches a session directory and emits rendered panel HTML when files change */
export class PanelEngine {
  private sessionDir: string | null = null;
  private watchers: fs.FSWatcher[] = [];
  private templateCache = new Map<string, HandlebarsTemplateDelegate>();
  private variables: Record<string, unknown> = {};
  private onUpdate: (panels: PanelData[]) => void;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(onUpdate: (panels: PanelData[]) => void) {
    this.onUpdate = onUpdate;
    this.registerHelpers();
  }

  private registerHelpers(): void {
    Handlebars.registerHelper("eq", (a, b) => a === b);
    Handlebars.registerHelper("ne", (a, b) => a !== b);
    Handlebars.registerHelper("lt", (a, b) => a < b);
    Handlebars.registerHelper("lte", (a, b) => a <= b);
    Handlebars.registerHelper("gt", (a, b) => a > b);
    Handlebars.registerHelper("gte", (a, b) => a >= b);
    Handlebars.registerHelper("and", (a, b) => a && b);
    Handlebars.registerHelper("or", (a, b) => a || b);
    Handlebars.registerHelper("not", (a) => !a);
    Handlebars.registerHelper("add", (a, b) => Number(a) + Number(b));
    Handlebars.registerHelper("subtract", (a, b) => Number(a) - Number(b));
    Handlebars.registerHelper("multiply", (a, b) => Number(a) * Number(b));
    Handlebars.registerHelper("divide", (a, b) =>
      Number(b) !== 0 ? Number(a) / Number(b) : 0
    );
    Handlebars.registerHelper("percentage", (val, max) =>
      Number(max) !== 0 ? Math.round((Number(val) / Number(max)) * 100) : 0
    );
    Handlebars.registerHelper("formatNumber", (n) =>
      Number(n).toLocaleString()
    );
  }

  /** Start watching a session directory */
  watch(sessionDir: string): void {
    this.stop();
    this.sessionDir = sessionDir;
    this.templateCache.clear();

    // Load initial variables
    this.loadVariables();

    // Watch variables.json
    const varsPath = path.join(sessionDir, "variables.json");
    if (fs.existsSync(varsPath)) {
      const watcher = fs.watch(varsPath, () => {
        this.loadVariables();
        this.scheduleRender();
      });
      this.watchers.push(watcher);
    }

    // Watch panels/ directory
    const panelsDir = path.join(sessionDir, "panels");
    if (fs.existsSync(panelsDir)) {
      const watcher = fs.watch(panelsDir, (_event, filename) => {
        if (filename && filename.endsWith(".html")) {
          // Invalidate template cache for changed file
          const rawName = filename.replace(/\.html$/, "");
          const name = rawName.replace(/^\d+-/, "");
          this.templateCache.delete(name);
        }
        this.scheduleRender();
      });
      this.watchers.push(watcher);
    }

    // Initial render
    this.render();
  }

  /** Get current panels without triggering onUpdate */
  getCurrentPanels(): PanelData[] {
    if (!this.sessionDir) return [];

    const panelsDir = path.join(this.sessionDir, "panels");
    if (!fs.existsSync(panelsDir)) return [];

    const files = fs
      .readdirSync(panelsDir)
      .filter((f) => f.endsWith(".html"))
      .sort();

    const panels: PanelData[] = [];
    for (const file of files) {
      const rawName = file.replace(/\.html$/, "");
      const name = rawName.replace(/^\d+-/, "");
      try {
        if (!this.templateCache.has(name)) {
          const source = fs.readFileSync(
            path.join(panelsDir, file),
            "utf-8"
          );
          this.templateCache.set(name, Handlebars.compile(source));
        }
        const template = this.templateCache.get(name)!;
        const html = template(this.variables, { allowProtoPropertiesByDefault: true });
        panels.push({ name, html });
      } catch {
        panels.push({
          name,
          html: `<div style="color:#ff4d6a;padding:8px;">Panel "${name}" render error</div>`,
        });
      }
    }
    return panels;
  }

  /** Stop watching */
  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    this.sessionDir = null;
    this.templateCache.clear();
    this.variables = {};
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Debounced render to coalesce rapid file changes */
  private scheduleRender(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.render();
    }, 100);
  }

  private loadVariables(): void {
    if (!this.sessionDir) return;
    const varsPath = path.join(this.sessionDir, "variables.json");
    try {
      if (fs.existsSync(varsPath)) {
        this.variables = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
      }
    } catch {
      // Malformed JSON — keep previous variables
    }
  }

  private render(): void {
    if (!this.sessionDir) return;

    const panelsDir = path.join(this.sessionDir, "panels");
    if (!fs.existsSync(panelsDir)) {
      this.onUpdate([]);
      return;
    }

    const files = fs
      .readdirSync(panelsDir)
      .filter((f) => f.endsWith(".html"))
      .sort();

    const panels: PanelData[] = [];

    for (const file of files) {
      const rawName = file.replace(/\.html$/, "");
      const name = rawName.replace(/^\d+-/, "");
      try {
        // Get or compile template
        if (!this.templateCache.has(name)) {
          const source = fs.readFileSync(
            path.join(panelsDir, file),
            "utf-8"
          );
          this.templateCache.set(name, Handlebars.compile(source));
        }

        const template = this.templateCache.get(name)!;
        const html = template(this.variables, { allowProtoPropertiesByDefault: true });
        panels.push({ name, html });
      } catch {
        // Template compile/render error — skip panel
        panels.push({
          name,
          html: `<div style="color:#ff4d6a;padding:8px;">Panel "${name}" render error</div>`,
        });
      }
    }

    this.onUpdate(panels);
  }
}
