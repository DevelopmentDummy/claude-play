// 서비스/빌더 시스템 프롬프트 + 가이드파일 조립. SessionManager에서 추출(Wave 12 cluster 5).
import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";
import { ensureHandlebarsHelpers } from "./panel-engine";
import type { AIProvider } from "./ai-provider";

const SERVICE_SESSION_GUIDE_FILES_CLAUDE = ["session-primer.yaml", "session-shared.md"] as const;
const SERVICE_SESSION_GUIDE_FILES_CODEX = ["session-primer-codex.yaml", "session-shared.md"] as const;
const SERVICE_SESSION_GUIDE_FILES_GEMINI = ["session-primer-gemini.yaml", "session-shared.md"] as const;
const BUILDER_GUIDE_FILES = ["builder-primer.yaml"] as const;

/** Read the builder meta-prompt, compiled with Handlebars for conditional sections */
export function getBuilderPrompt(appRoot: string, context: { localTtsAvailable?: boolean } = {}): string {
  ensureHandlebarsHelpers();
  const promptPath = path.join(appRoot, "builder-prompt.md");
  const source = fs.readFileSync(promptPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context);
}

export function buildServiceSystemPrompt(appRoot: string, personaName?: string, provider?: AIProvider, options?: Record<string, unknown>, userName?: string): string {
  const files = provider === "codex"
    ? SERVICE_SESSION_GUIDE_FILES_CODEX
    : provider === "gemini"
    ? SERVICE_SESSION_GUIDE_FILES_GEMINI
    : provider === "kimi"
    ? SERVICE_SESSION_GUIDE_FILES_CODEX
    : provider === "antigravity"
    ? SERVICE_SESSION_GUIDE_FILES_GEMINI
    : SERVICE_SESSION_GUIDE_FILES_CLAUDE;
  return buildPromptFromGuideFiles(appRoot, files, personaName, options, userName);
}

export function buildBuilderSystemPrompt(appRoot: string, personaName?: string, options?: Record<string, unknown>): string {
  return buildPromptFromGuideFiles(appRoot, BUILDER_GUIDE_FILES, personaName, options);
}

export function buildPromptFromGuideFiles(appRoot: string, files: readonly string[], personaName?: string, options?: Record<string, unknown>, userName?: string): string {
  const sections: string[] = [];
  for (const filename of files) {
    const guidePath = path.join(appRoot, filename);
    if (!fs.existsSync(guidePath)) continue;
    const content = readGuideContent(guidePath, personaName, options, userName);
    if (content) sections.push(content);
  }
  return sections.join("\n\n").trim();
}

export function readGuideContent(guidePath: string, personaName?: string, options?: Record<string, unknown>, userName?: string): string {
  const raw = fs.readFileSync(guidePath, "utf-8");
  const ext = path.extname(guidePath).toLowerCase();
  let base = ext === ".yaml" || ext === ".yml"
    ? extractActiveSystemPrompt(raw) || raw
    : raw;
  const actorName = personaName || "the current persona";
  base = base.replace(/\{agent_name\}/g, actorName);
  const resolvedUserName = userName || "the user";
  base = base.replace(/\{user_name\}/g, resolvedUserName).trim();

  // Compile Handlebars for .md files when options are provided
  if (options && ext === ".md") {
    try {
      const template = Handlebars.compile(base, { noEscape: true });
      base = template({ options }, { allowProtoPropertiesByDefault: true });
    } catch { /* fall through with uncompiled content */ }
  }

  return base;
}

export function extractActiveSystemPrompt(yamlText: string): string | null {
  const lines = yamlText.split(/\r?\n/);
  const activeLine = lines.find((line) => /^active_system_prompt:\s*/.test(line));
  if (!activeLine) return null;

  const activeMatch = activeLine.match(
    /^active_system_prompt:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*$/
  );
  const activeKey = activeMatch?.[1] || activeMatch?.[2] || activeMatch?.[3];
  if (!activeKey) return null;

  const blockHeader = new RegExp(`^${escapeRegExp(activeKey)}:\\s*\\|\\s*$`);
  const startIndex = lines.findIndex((line) => blockHeader.test(line));
  if (startIndex < 0) return null;

  const blockLines: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("  ")) {
      blockLines.push(line.slice(2));
      continue;
    }
    if (line.trim() === "") {
      blockLines.push("");
      continue;
    }
    break;
  }

  const blockText = blockLines.join("\n").trim();
  return blockText || null;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
