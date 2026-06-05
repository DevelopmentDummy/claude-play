/**
 * panel-action-spec.ts
 *
 * Pure (no Node/browser deps) shared definitions for panel action specs sourced
 * from panels/_actions.meta.json. Imported by both the client-side registry
 * (panel-action-registry.ts) and the server-side reader (panel-actions-meta.ts)
 * so the spec shape and one-line formatter live in exactly one place.
 */

/** Per-action spec sourced from panels/_actions.meta.json (server-side sidecar). */
export interface ActionSpec {
  label: string;
  required?: string[];
  values?: Record<string, string[]>;
  note?: string;
}

/**
 * Format a single action spec as a one-line signature string, used both for
 * `[정의]` reminder events (client) and system-prompt injection (server).
 * e.g. `베스라.besra_evening(필수: action ∈ {conversation,wine_session,...}) [라벨] — 노트`
 */
export function formatActionSpecLine(panel: string, action: string, spec: ActionSpec): string {
  const required = spec.required ?? [];
  const reqParts: string[] = [];
  for (const param of required) {
    const values = spec.values?.[param];
    if (values && values.length > 0) {
      const enumStr = values.length <= 6
        ? values.join(",")
        : `${values.slice(0, 5).join(",")},...총 ${values.length}개`;
      reqParts.push(`${param} ∈ {${enumStr}}`);
    } else {
      reqParts.push(param);
    }
  }
  const sig = reqParts.length > 0 ? `필수: ${reqParts.join(", ")}` : "no-arg";
  const noteSuffix = spec.note ? ` — ${spec.note}` : "";
  return `${panel}.${action}(${sig}) [${spec.label}]${noteSuffix}`;
}
