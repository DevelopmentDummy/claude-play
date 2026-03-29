/**
 * panel-action-registry.ts
 *
 * Client-side singleton that manages panel action metadata, handlers,
 * execution recording, and available/history header generation.
 *
 * Runs only in browser context (no "use client" directive needed since
 * this is a plain library, not a React component/hook).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelActionMeta {
  id: string;
  panel: string;
  label: string;
  description: string;
  params?: Record<string, string>;
  available_when?: string;
}

export type PanelActionHandler = (
  params?: Record<string, unknown>
) => Promise<void>;

export interface PanelActionRecord {
  panel: string;
  action: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal storage shape
// ---------------------------------------------------------------------------

interface ActionEntry {
  meta: PanelActionMeta;
  handler?: PanelActionHandler;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class PanelActionRegistry {
  /** panel → actionId → entry */
  private entries: Map<string, Map<string, ActionEntry>> = new Map();
  private variables: Record<string, unknown> = {};
  private sessionId: string | null = null;

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register metadata from `<panel-actions>` tag parsing.
   * Clears old *meta* entries for this panel but preserves existing handlers.
   */
  registerMeta(
    panel: string,
    metas: Array<Omit<PanelActionMeta, "panel">>
  ): void {
    // Collect existing handlers before clearing
    const existingHandlers = new Map<string, PanelActionHandler>();
    const panelMap = this.entries.get(panel);
    if (panelMap) {
      for (const [actionId, entry] of panelMap) {
        if (entry.handler) {
          existingHandlers.set(actionId, entry.handler);
        }
      }
    }

    // Rebuild the panel map with fresh metas
    const newPanelMap = new Map<string, ActionEntry>();
    for (const metaWithoutPanel of metas) {
      const meta: PanelActionMeta = { ...metaWithoutPanel, panel };
      const entry: ActionEntry = { meta };
      // Restore handler if one was previously registered
      const existingHandler = existingHandlers.get(meta.id);
      if (existingHandler) {
        entry.handler = existingHandler;
      }
      newPanelMap.set(meta.id, entry);
    }

    this.entries.set(panel, newPanelMap);
  }

  /**
   * Register a runtime handler for a specific action.
   * Dispatches `__panel_action_registered` CustomEvent when complete.
   */
  registerHandler(
    panel: string,
    actionId: string,
    handler: PanelActionHandler
  ): void {
    let panelMap = this.entries.get(panel);
    if (!panelMap) {
      panelMap = new Map();
      this.entries.set(panel, panelMap);
    }

    const existing = panelMap.get(actionId);
    if (existing) {
      existing.handler = handler;
    } else {
      // No meta yet — create a stub entry so the handler is preserved
      const stubMeta: PanelActionMeta = {
        id: actionId,
        panel,
        label: actionId,
        description: "",
      };
      panelMap.set(actionId, { meta: stubMeta, handler });
    }

    // Notify waitForHandler listeners
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("__panel_action_registered", {
          detail: `${panel}.${actionId}`,
        })
      );
    }
  }

  // -------------------------------------------------------------------------
  // Variables / availability
  // -------------------------------------------------------------------------

  /** Update variables used for available_when evaluation */
  updateVariables(vars: Record<string, unknown>): void {
    this.variables = { ...vars };
  }

  /** Evaluate available_when expression safely */
  private evalAvailableWhen(expr: string): boolean {
    try {
      // Filter to valid JS identifier keys only (e.g. skip "schedule-config")
      const validEntries = Object.entries(this.variables).filter(
        ([k]) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)
      );
      const keys = validEntries.map(([k]) => k);
      const values = validEntries.map(([, v]) => v);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(...keys, `return (${expr})`);
      return Boolean(fn(...values));
    } catch {
      return false;
    }
  }

  /** Check if a handler is registered for a specific action */
  hasHandler(panel: string, actionId: string): boolean {
    const resolvedPanel = panel || this.findPanelByAction(actionId);
    if (!resolvedPanel) return false;
    const panelMap = this.entries.get(resolvedPanel);
    return !!panelMap?.get(actionId)?.handler;
  }

  /** Find label for a specific action, regardless of availability */
  getLabel(panel: string, actionId: string): string | undefined {
    const panelMap = this.entries.get(panel);
    return panelMap?.get(actionId)?.meta.label;
  }

  /** Find label by actionId only (searches all panels) */
  getLabelByAction(actionId: string): string | undefined {
    for (const panelMap of this.entries.values()) {
      const entry = panelMap.get(actionId);
      if (entry) return entry.meta.label;
    }
    return undefined;
  }

  /** Return all actions whose available_when evaluates to true (or is absent) */
  getAvailable(): PanelActionMeta[] {
    const result: PanelActionMeta[] = [];
    for (const panelMap of this.entries.values()) {
      for (const { meta } of panelMap.values()) {
        if (
          meta.available_when === undefined ||
          meta.available_when === "" ||
          this.evalAvailableWhen(meta.available_when)
        ) {
          result.push(meta);
        }
      }
    }
    return result;
  }

  /**
   * Build the [AVAILABLE] header string.
   * Format: `[AVAILABLE] panel.actionId(label param1,param2), ...`
   * Returns empty string if no available actions.
   */
  buildAvailableHeader(): string {
    const available = this.getAvailable();
    if (available.length === 0) return "";

    const parts = available.map((meta) => {
      const paramKeys =
        meta.params && Object.keys(meta.params).length > 0
          ? Object.keys(meta.params).join(",")
          : "";
      const inner = paramKeys
        ? `${meta.label} ${paramKeys}`
        : meta.label;
      return `${meta.panel}.${meta.id}(${inner})`;
    });

    return `[AVAILABLE] ${parts.join(", ")}`;
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /**
   * Find which panel owns a given actionId.
   * Returns the panel name, or undefined if not found.
   */
  findPanelByAction(actionId: string): string | undefined {
    for (const [panelName, panelMap] of this.entries) {
      if (panelMap.has(actionId)) return panelName;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Record action via API call, then invoke the handler.
   * Throws if no handler is registered for the action.
   * If panel is empty, auto-resolves from registry.
   */
  async execute(
    panel: string,
    actionId: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    const resolvedPanel = panel || this.findPanelByAction(actionId);
    if (!resolvedPanel) {
      throw new Error(
        `No panel found for action "${actionId}"`
      );
    }
    const panelMap = this.entries.get(resolvedPanel);
    const entry = panelMap?.get(actionId);

    if (!entry?.handler) {
      throw new Error(
        `No handler registered for action "${resolvedPanel}.${actionId}"`
      );
    }

    // Record via API (best-effort, don't block execution on failure)
    if (this.sessionId) {
      const record: PanelActionRecord = { panel: resolvedPanel, action: actionId };
      if (params !== undefined) record.params = params;

      fetch(`/api/sessions/${this.sessionId}/panel-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }).catch(() => {
        // Silently ignore recording failures
      });
    }

    await entry.handler(params);
  }

  /**
   * Wait until a handler is registered for the given action.
   * Resolves immediately if the handler already exists.
   * Rejects with a timeout error after `timeoutMs` milliseconds.
   */
  waitForHandler(
    panel: string,
    actionId: string,
    timeoutMs = 5000
  ): Promise<void> {
    // Check if already registered
    const panelMap = this.entries.get(panel);
    if (panelMap?.get(actionId)?.handler) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const targetKey = `${panel}.${actionId}`;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const onRegistered = (event: Event) => {
        const detail = (event as CustomEvent<string>).detail;
        if (detail === targetKey) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        window.removeEventListener("__panel_action_registered", onRegistered);
      };

      window.addEventListener("__panel_action_registered", onRegistered);

      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timeout waiting for handler "${targetKey}" after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
    });
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Remove all actions (meta + handlers) for a panel */
  clearPanel(panel: string): void {
    this.entries.delete(panel);
  }

  /** Remove all entries */
  clear(): void {
    this.entries.clear();
  }

  /** Debug: return snapshot of registry state */
  debug(): Record<string, unknown> {
    const actions: Record<string, string[]> = {};
    for (const [panel, panelMap] of this.entries) {
      actions[panel] = [...panelMap.keys()];
    }
    const validVars = Object.entries(this.variables)
      .filter(([k]) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k))
      .reduce((o, [k, v]) => { o[k] = v; return o; }, {} as Record<string, unknown>);
    return {
      registeredPanels: actions,
      variableKeys: Object.keys(validVars),
      turn_phase: validVars.turn_phase,
      current_slot: validVars.current_slot,
      available: this.getAvailable().map(a => `${a.panel}.${a.id}(${a.available_when || "always"})`),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: PanelActionRegistry | null = null;

export function getPanelActionRegistry(): PanelActionRegistry {
  if (!_instance) {
    _instance = new PanelActionRegistry();
  }
  return _instance;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Extract panel action metadata from `<panel-actions>...</panel-actions>` tags
 * embedded in an HTML string. Returns an array of action metas without `panel`.
 */
export function parsePanelActions(
  html: string
): Array<Omit<PanelActionMeta, "panel">> {
  const results: Array<Omit<PanelActionMeta, "panel">> = [];
  // Match one or more <panel-actions> blocks
  const tagRegex = /<panel-actions[^>]*>([\s\S]*?)<\/panel-actions>/gi;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagRegex.exec(html)) !== null) {
    const content = tagMatch[1].trim();
    if (!content) continue;

    try {
      const parsed: unknown = JSON.parse(content);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).label === "string"
        ) {
          const raw = item as Record<string, unknown>;
          const meta: Omit<PanelActionMeta, "panel"> = {
            id: raw.id as string,
            label: raw.label as string,
            description:
              typeof raw.description === "string" ? raw.description : "",
          };
          if (raw.params && typeof raw.params === "object") {
            meta.params = raw.params as Record<string, string>;
          }
          if (typeof raw.available_when === "string") {
            meta.available_when = raw.available_when;
          }
          results.push(meta);
        }
      }
    } catch {
      // Malformed JSON — skip this block
    }
  }

  return results;
}

/**
 * Remove `<panel-actions>...</panel-actions>` tags from HTML string.
 * Call before setting innerHTML so the metadata block doesn't render.
 */
export function stripPanelActions(html: string): string {
  return html.replace(/<panel-actions[^>]*>[\s\S]*?<\/panel-actions>/gi, "");
}
