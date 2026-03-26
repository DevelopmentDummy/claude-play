import fs from "fs";
import path from "path";

export interface HintRule {
  format?: string;
  max?: number;
  max_key?: string;
  tiers?: { max: number; hint: string }[];
  tier_mode?: "percentage" | "value";
}

export type HintRules = Record<string, HintRule>;

export type SnapshotEntry = string | { display: string; hint?: string };
export type Snapshot = Record<string, SnapshotEntry>;

// Keep in sync with src/mcp/claude-bridge-mcp-server.mjs buildSnapshot()
const PASSTHROUGH_KEYS = [
  "location", "owner_location", "time", "outfit",
  "cycle_phase", "cycle_day", "day_number",
];

export function readHintRules(sessionDir: string): HintRules | null {
  const rulesPath = path.join(sessionDir, "hint-rules.json");
  try {
    if (fs.existsSync(rulesPath)) {
      return JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
    }
  } catch { /* ignore */ }
  return null;
}

export function buildSnapshot(
  vars: Record<string, unknown>,
  hintRules: HintRules
): Snapshot {
  const snapshot: Snapshot = {};

  for (const [key, rule] of Object.entries(hintRules)) {
    const value = vars[key];
    if (value === undefined) continue;

    const entry: { display: string; hint?: string } = { display: "" };

    if (rule.format) {
      let formatted = rule.format;
      formatted = formatted.replace("{value}", String(value));
      if (rule.max_key && vars[rule.max_key] !== undefined) {
        formatted = formatted.replace("{max}", String(vars[rule.max_key]));
      } else if (rule.max !== undefined) {
        formatted = formatted.replace("{max}", String(rule.max));
      }
      const maxVal = rule.max_key ? vars[rule.max_key] : rule.max;
      if (typeof value === "number" && typeof maxVal === "number" && maxVal > 0) {
        const pct = Math.round((value / maxVal) * 100);
        formatted = formatted.replace("{pct}", String(pct));
      }
      entry.display = formatted;
    } else {
      entry.display = String(value);
    }

    if (Array.isArray(rule.tiers) && typeof value === "number") {
      const maxVal = rule.max_key ? vars[rule.max_key] : rule.max;
      const pct = typeof maxVal === "number" && maxVal > 0
        ? (value / maxVal) * 100
        : value;
      const checkValue = rule.tier_mode === "percentage" ? pct : value;
      for (const tier of rule.tiers) {
        if (checkValue <= tier.max) {
          entry.hint = tier.hint;
          break;
        }
      }
    }

    snapshot[key] = typeof value === "string" ? entry.display : entry;
  }

  for (const passKey of PASSTHROUGH_KEYS) {
    if (vars[passKey] !== undefined && !(passKey in snapshot)) {
      snapshot[passKey] = String(vars[passKey]);
    }
  }

  return snapshot;
}

/**
 * Build a one-line [STATE] string for chat message prepending.
 * Returns empty string if no hint-rules.json exists.
 */
export function buildHintSnapshotLine(sessionDir: string): string {
  const rules = readHintRules(sessionDir);
  if (!rules) return "";

  const varsPath = path.join(sessionDir, "variables.json");
  let vars: Record<string, unknown> = {};
  try {
    if (fs.existsSync(varsPath)) {
      vars = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
    }
  } catch { /* ignore */ }

  const snapshot = buildSnapshot(vars, rules);
  if (Object.keys(snapshot).length === 0) return "";

  const parts: string[] = [];
  for (const [key, entry] of Object.entries(snapshot)) {
    if (typeof entry === "string") {
      parts.push(`${key}=${entry}`);
    } else {
      const hint = entry.hint ? `(hint: "${entry.hint}")` : "";
      parts.push(`${key}=${entry.display}${hint}`);
    }
  }

  return `[STATE] ${parts.join(", ")}`;
}
