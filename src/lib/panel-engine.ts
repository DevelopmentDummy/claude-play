import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";
import { getDataDir } from "./data-dir";

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
  "voice.json",
  "chat-options.json",
  "pending-events.json",
]);

export interface PanelUpdate {
  panels: PanelData[];
  context: Record<string, unknown>;
  /** Default placement for shared panels (panel name → placement type) */
  sharedPlacements?: Record<string, "modal">;
  popups?: Array<{ template: string; html: string; duration: number }>;
}


let helpersRegistered = false;

/** Register Handlebars helpers globally (idempotent) */
export function ensureHandlebarsHelpers(): void {
  if (helpersRegistered) return;
  helpersRegistered = true;
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
  Handlebars.registerHelper("json", (val) =>
    new Handlebars.SafeString(JSON.stringify(val ?? null))
  );
}

/** Watches a session directory and emits rendered panel HTML when files change */
export class PanelEngine {
  private sessionDir: string | null = null;
  private watchers: fs.FSWatcher[] = [];
  private dataFileWatchers = new Map<string, fs.FSWatcher>();
  private templateCache = new Map<string, HandlebarsTemplateDelegate>();
  private autoRefreshCache = new Map<string, string>(); // panel name → cached rendered HTML
  private templateDirty = new Set<string>(); // panels whose templates just changed
  private variables: Record<string, unknown> = {};
  private dataFiles: Record<string, unknown> = {};
  private onUpdate: (update: PanelUpdate) => void;
  private onLayoutUpdate: (() => void) | null = null;
  private onImageUpdate: ((filename: string) => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private imageDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    onUpdate: (update: PanelUpdate) => void,
    onLayoutUpdate?: () => void,
    onImageUpdate?: (filename: string) => void,
  ) {
    this.onUpdate = onUpdate;
    this.onLayoutUpdate = onLayoutUpdate || null;
    this.onImageUpdate = onImageUpdate || null;
    this.registerHelpers();
  }

  private registerHelpers(): void {
    ensureHandlebarsHelpers();
  }

  /** Build the merged template context: variables at root + data files as named keys + system vars */
  private getContext(): Record<string, unknown> {
    // Extract session ID from directory name for resource URL construction
    const sessionId = this.sessionDir ? path.basename(this.sessionDir) : "";
    let layout: unknown = null;
    if (this.sessionDir) {
      try {
        layout = JSON.parse(fs.readFileSync(path.join(this.sessionDir, "layout.json"), "utf-8"));
      } catch {}
    }
    return {
      ...this.variables,
      ...this.dataFiles,
      __sessionId: sessionId,
      __imageBase: sessionId ? `/api/sessions/${sessionId}/files/images/` : "",
      __layout: layout,
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
          this.autoRefreshCache.delete(name);
          this.templateDirty.add(name);
        }
        this.scheduleRender();
      });
      this.watchers.push(watcher);
    }

    // Watch popups/ directory
    const popupsDir = path.join(sessionDir, "popups");
    if (fs.existsSync(popupsDir)) {
      const watcher = fs.watch(popupsDir, (_event, filename) => {
        if (filename && filename.endsWith(".html")) {
          const name = filename.replace(/\.html$/, "");
          this.templateCache.delete(`popup:${name}`);
        }
        this.scheduleRender();
      });
      this.watchers.push(watcher);
    }

    // Watch images/ directory for file changes (new or overwritten images)
    this.watchImagesDir(sessionDir);

    // Watch each existing data JSON file individually (more reliable on Windows)
    this.watchDataFiles();

    // Also watch session dir for NEW json files or images/ dir appearing
    const dirWatcher = fs.watch(sessionDir, (_event, filename) => {
      if (filename === "layout.json") {
        this.broadcastLayout();
        return;
      }
      if (filename === "images") {
        // images/ directory may have just been created — start watching it
        this.watchImagesDir(sessionDir);
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

  /** Collect panel source files from a directory */
  private collectPanelFiles(dir: string): Array<{ file: string; filePath: string; name: string }> {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".html"))
      .sort()
      .map((file) => {
        const rawName = file.replace(/\.html$/, "");
        const name = rawName.replace(/^\d+-/, "");
        return { file, filePath: path.join(dir, file), name };
      });
  }

  /** Scan data/tools/[tool]/panels/ for shared panels available to all sessions */
  private getSharedPanelFiles(): Array<{ file: string; filePath: string; name: string }> {
    const toolsDir = path.join(getDataDir(), "tools");
    if (!fs.existsSync(toolsDir)) return [];
    const result: Array<{ file: string; filePath: string; name: string }> = [];
    try {
      for (const toolEntry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
        if (!toolEntry.isDirectory()) continue;
        const panelsDir = path.join(toolsDir, toolEntry.name, "panels");
        result.push(...this.collectPanelFiles(panelsDir));
      }
    } catch { /* ignore */ }
    return result;
  }

  /** Get current panels + context without triggering onUpdate */
  getCurrentPanels(): PanelUpdate {
    if (!this.sessionDir) return { panels: [], context: {} };

    // Collect session panels + shared tool panels
    const sessionPanelsDir = path.join(this.sessionDir, "panels");
    const sessionPanelFiles = this.collectPanelFiles(sessionPanelsDir);
    const sharedPanelFiles = this.getSharedPanelFiles();

    // Session panels first, then shared panels (skip name conflicts)
    const seenNames = new Set<string>();
    const sharedNames = new Set<string>();
    const allFiles: Array<{ file: string; filePath: string; name: string }> = [];
    for (const pf of sessionPanelFiles) {
      seenNames.add(pf.name);
      allFiles.push(pf);
    }
    for (const pf of sharedPanelFiles) {
      if (!seenNames.has(pf.name)) {
        seenNames.add(pf.name);
        sharedNames.add(pf.name);
        allFiles.push(pf);
      }
    }

    const context = this.getContext();

    // Read autoRefresh config from layout.json
    let autoRefreshConfig: Record<string, boolean> = {};
    if (this.sessionDir) {
      try {
        const layout = JSON.parse(fs.readFileSync(path.join(this.sessionDir, "layout.json"), "utf-8"));
        autoRefreshConfig = layout?.panels?.autoRefresh || {};
      } catch { /* ignore */ }
    }

    const panels: PanelData[] = [];
    for (const { filePath, name } of allFiles) {
      const isAutoRefresh = autoRefreshConfig[name] !== false; // default true

      // If autoRefresh is disabled and we have cached HTML (and template hasn't changed), use cache
      if (!isAutoRefresh && this.autoRefreshCache.has(name) && !this.templateDirty.has(name)) {
        panels.push({ name, html: this.autoRefreshCache.get(name)! });
        continue;
      }

      try {
        if (!this.templateCache.has(name)) {
          const source = fs.readFileSync(filePath, "utf-8");
          this.templateCache.set(name, Handlebars.compile(source));
        }
        const template = this.templateCache.get(name)!;
        const html = template(context, { allowProtoPropertiesByDefault: true });

        // Cache for autoRefresh:false panels
        if (!isAutoRefresh) {
          this.autoRefreshCache.set(name, html);
        }

        panels.push({ name, html });
      } catch {
        panels.push({
          name,
          html: `<div style="color:#ff4d6a;padding:8px;">Panel "${name}" render error</div>`,
        });
      }
    }
    // Build shared placement map (all shared panels default to modal)
    const sharedPlacements: Record<string, "modal"> = {};
    for (const name of sharedNames) {
      sharedPlacements[name] = "modal";
    }

    const popups = this.renderPopups(context);
    return { panels, context, sharedPlacements, ...(popups.length > 0 ? { popups } : {}) };
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
    this.autoRefreshCache.clear();
    this.templateDirty.clear();
    this.imageWatcherActive = false;
    for (const t of this.imageDebounce.values()) clearTimeout(t);
    this.imageDebounce.clear();
    this.variables = {};
    this.dataFiles = {};
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Invalidate autoRefresh cache for a specific panel, forcing re-render on next render cycle */
  invalidatePanel(name: string): void {
    this.autoRefreshCache.delete(name);
  }

  /** Force reload all data and re-render (called at end of Claude turn) */
  reload(): void {
    this.loadVariables();
    this.loadDataFiles();
    this.watchDataFiles();
    // Clear autoRefresh cache so that autoRefresh:false panels also re-render at turn end
    this.autoRefreshCache.clear();
    console.log("[panel-engine] reload — dataFiles keys:", Object.keys(this.dataFiles), "inventory items:", (this.dataFiles.inventory as Record<string, unknown>)?.items ? "yes" : "no");
    this.render();
  }

  /** Render popup templates from __popups queue in variables */
  private renderPopups(context: Record<string, unknown>): Array<{ template: string; html: string; duration: number }> {
    if (!this.sessionDir) return [];
    const popupQueue = this.variables.__popups as Array<{ template: string; duration?: number; vars?: Record<string, unknown> }> | undefined;
    if (!Array.isArray(popupQueue) || popupQueue.length === 0) return [];

    const popupsDir = path.join(this.sessionDir, "popups");
    const result: Array<{ template: string; html: string; duration: number }> = [];

    for (const entry of popupQueue) {
      if (!entry.template) continue;
      const filePath = path.join(popupsDir, `${entry.template}.html`);
      if (!fs.existsSync(filePath)) continue;

      const cacheKey = `popup:${entry.template}`;
      try {
        if (!this.templateCache.has(cacheKey)) {
          const source = fs.readFileSync(filePath, "utf-8");
          this.templateCache.set(cacheKey, Handlebars.compile(source));
        }
        const template = this.templateCache.get(cacheKey)!;
        const popupContext = entry.vars ? { ...context, ...entry.vars } : context;
        const html = template(popupContext, { allowProtoPropertiesByDefault: true });
        result.push({ template: entry.template, html, duration: entry.duration || 4000 });
      } catch {
        // skip broken templates
      }
    }
    return result;
  }

  /** Debounced render to coalesce rapid file changes */
  scheduleRender(): void {
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

  /** Track whether images/ watcher is already active */
  private imageWatcherActive = false;

  /** Watch images/ directory for file changes, with lazy init */
  private watchImagesDir(sessionDir: string): void {
    if (!this.onImageUpdate || this.imageWatcherActive) return;
    const imagesDir = path.join(sessionDir, "images");
    if (!fs.existsSync(imagesDir)) return;
    this.imageWatcherActive = true;
    const imgWatcher = fs.watch(imagesDir, (_event, filename) => {
      if (!filename) return;
      // Debounce per-file to coalesce rapid writes
      const existing = this.imageDebounce.get(filename);
      if (existing) clearTimeout(existing);
      this.imageDebounce.set(filename, setTimeout(() => {
        this.imageDebounce.delete(filename);
        this.onImageUpdate?.(filename);
      }, 300));
    });
    this.watchers.push(imgWatcher);
  }

  private render(): void {
    if (!this.sessionDir) return;
    const result = this.getCurrentPanels();
    this.templateDirty.clear();
    this.onUpdate(result);
  }
}
