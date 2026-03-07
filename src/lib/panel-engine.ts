import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";

export interface PanelData {
  name: string; // filename without extension
  html: string; // rendered HTML
}

/** System JSON files that should NOT be loaded as data */
const SYSTEM_JSON = new Set([
  "variables.json",
  "session.json",
  "builder-session.json",
  "comfyui-config.json",
  "layout.json",
  "chat-history.json",
  "package.json",
  "tsconfig.json",
  "character-tags.json",
]);

export interface PanelUpdate {
  panels: PanelData[];
  context: Record<string, unknown>;
}


/** Watches a session directory and emits rendered panel HTML when files change */
export class PanelEngine {
  private sessionDir: string | null = null;
  private watchers: fs.FSWatcher[] = [];
  private dataFileWatchers = new Map<string, fs.FSWatcher>();
  private templateCache = new Map<string, HandlebarsTemplateDelegate>();
  private variables: Record<string, unknown> = {};
  private dataFiles: Record<string, unknown> = {};
  private onUpdate: (update: PanelUpdate) => void;
  private onLayoutUpdate: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(onUpdate: (update: PanelUpdate) => void, onLayoutUpdate?: () => void) {
    this.onUpdate = onUpdate;
    this.onLayoutUpdate = onLayoutUpdate || null;
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

  /** Build the merged template context: variables at root + data files as named keys + system vars */
  private getContext(): Record<string, unknown> {
    // Extract session ID from directory name for resource URL construction
    const sessionId = this.sessionDir ? path.basename(this.sessionDir) : "";
    return {
      ...this.variables,
      ...this.dataFiles,
      __sessionId: sessionId,
      __imageBase: sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/files?path=images/` : "",
    };
  }

  /** Start watching a session directory */
  watch(sessionDir: string): void {
    this.stop();
    this.sessionDir = sessionDir;
    this.templateCache.clear();

    // Load initial data
    this.loadVariables();
    this.loadDataFiles();

    // Watch variables.json
    const varsPath = path.join(sessionDir, "variables.json");
    if (fs.existsSync(varsPath)) {
      const watcher = fs.watch(varsPath, () => {
        this.loadVariables();
        this.scheduleRender();
      });
      this.watchers.push(watcher);
    }

    // Watch layout.json for real-time layout changes
    const layoutPath = path.join(sessionDir, "layout.json");
    if (fs.existsSync(layoutPath) && this.onLayoutUpdate) {
      const layoutWatcher = fs.watch(layoutPath, () => {
        this.broadcastLayout();
      });
      this.watchers.push(layoutWatcher);
    }

    // Watch panels/ directory
    const panelsDir = path.join(sessionDir, "panels");
    if (fs.existsSync(panelsDir)) {
      const watcher = fs.watch(panelsDir, (_event, filename) => {
        if (filename && filename.endsWith(".html")) {
          const rawName = filename.replace(/\.html$/, "");
          const name = rawName.replace(/^\d+-/, "");
          this.templateCache.delete(name);
        }
        this.scheduleRender();
      });
      this.watchers.push(watcher);
    }

    // Watch each existing data JSON file individually (more reliable on Windows)
    this.watchDataFiles();

    // Also watch session dir for NEW json files appearing
    const dirWatcher = fs.watch(sessionDir, (_event, filename) => {
      if (filename === "layout.json") {
        this.broadcastLayout();
        return;
      }
      if (filename && filename.endsWith(".json") && !SYSTEM_JSON.has(filename)) {
        // A new data file may have appeared — re-watch all data files
        this.watchDataFiles();
        this.loadDataFiles();
        this.scheduleRender();
      }
    });
    this.watchers.push(dirWatcher);

    // Initial render
    this.render();
  }

  /** Get current panels + context without triggering onUpdate */
  getCurrentPanels(): PanelUpdate {
    if (!this.sessionDir) return { panels: [], context: {} };

    const panelsDir = path.join(this.sessionDir, "panels");
    if (!fs.existsSync(panelsDir)) return { panels: [], context: this.getContext() };

    const files = fs
      .readdirSync(panelsDir)
      .filter((f) => f.endsWith(".html"))
      .sort();

    const context = this.getContext();
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
        const html = template(context, { allowProtoPropertiesByDefault: true });
        panels.push({ name, html });
      } catch {
        panels.push({
          name,
          html: `<div style="color:#ff4d6a;padding:8px;">Panel "${name}" render error</div>`,
        });
      }
    }
    return { panels, context };
  }

  /** Stop watching */
  stop(): void {
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
    this.dataFileWatchers.clear();
    this.sessionDir = null;
    this.templateCache.clear();
    this.variables = {};
    this.dataFiles = {};
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Force reload all data and re-render (called at end of Claude turn) */
  reload(): void {
    this.loadVariables();
    this.loadDataFiles();
    this.watchDataFiles();
    console.log("[panel-engine] reload — dataFiles keys:", Object.keys(this.dataFiles), "inventory items:", (this.dataFiles.inventory as Record<string, unknown>)?.items ? "yes" : "no");
    this.render();
  }

  /** Debounced render to coalesce rapid file changes */
  private scheduleRender(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.render();
    }, 100);
  }

  /** Watch individual data JSON files for reliable change detection */
  private watchDataFiles(): void {
    if (!this.sessionDir) return;
    try {
      const entries = fs.readdirSync(this.sessionDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json") || SYSTEM_JSON.has(entry)) continue;
        if (this.dataFileWatchers.has(entry)) continue;
        const filePath = path.join(this.sessionDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          const watcher = fs.watch(filePath, () => {
            this.loadDataFiles();
            this.scheduleRender();
          });
          this.dataFileWatchers.set(entry, watcher);
          this.watchers.push(watcher);
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
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

  /** Scan session directory for custom JSON data files and load them */
  private loadDataFiles(): void {
    if (!this.sessionDir) return;
    const newData: Record<string, unknown> = {};
    try {
      const entries = fs.readdirSync(this.sessionDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json") || SYSTEM_JSON.has(entry)) continue;
        const filePath = path.join(this.sessionDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          const key = entry.replace(/\.json$/, "");
          newData[key] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        } catch { /* skip malformed files */ }
      }
    } catch { /* ignore */ }
    this.dataFiles = newData;
  }

  /** Notify layout.json changed */
  private broadcastLayout(): void {
    if (!this.sessionDir || !this.onLayoutUpdate) return;
    this.onLayoutUpdate();
  }

  private render(): void {
    if (!this.sessionDir) return;
    const result = this.getCurrentPanels();
    this.onUpdate(result);
  }
}
