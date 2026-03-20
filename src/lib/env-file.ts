// src/lib/env-file.ts
import fs from "fs";
import path from "path";

const ENV_PATH = path.join(process.cwd(), ".env.local");

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    // Strip inline comments (only outside quotes)
    const value = stripQuotes(raw.startsWith('"') || raw.startsWith("'") ? raw : raw.replace(/\s+#.*$/, ""));
    result[key] = value;
  }
  return result;
}

export function writeEnvFile(values: Record<string, string>): void {
  // Read existing to preserve comments and ordering
  const existingLines: string[] = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, "utf-8").split("\n")
    : [];

  const remaining = { ...values };
  const outputLines: string[] = [];

  // Update existing keys in-place
  for (const line of existingLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      outputLines.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) { outputLines.push(line); continue; }
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in remaining) {
      const v = remaining[key];
      outputLines.push(v.includes(" ") || v.includes("#") ? `${key}="${v}"` : `${key}=${v}`);
      delete remaining[key];
    } else {
      outputLines.push(line);
    }
  }

  // Append new keys
  for (const [key, value] of Object.entries(remaining)) {
    outputLines.push(value.includes(" ") || value.includes("#") ? `${key}="${value}"` : `${key}=${value}`);
  }

  // Atomic write: write to temp, then rename
  const tmpPath = ENV_PATH + ".tmp";
  fs.writeFileSync(tmpPath, outputLines.join("\n"), "utf-8");
  fs.renameSync(tmpPath, ENV_PATH);
}

export function getEnvPath(): string {
  return ENV_PATH;
}
