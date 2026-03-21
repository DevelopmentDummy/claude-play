import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";
import { getDataDir } from "./data-dir";
import { getInternalToken } from "./auth";
import { providerFromModel } from "./ai-provider";

/** Read the selected writing style content for a persona, if any */
function readPersonaStyleContent(personaDir: string): string | null {
  const stylePath = path.join(personaDir, "style.json");
  if (!fs.existsSync(stylePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(stylePath, "utf-8"));
    const styleName = parsed.style;
    if (!styleName) return null;
    const styleFile = path.join(getDataDir(), "styles", `${styleName}.md`);
    if (!fs.existsSync(styleFile)) return null;
    return fs.readFileSync(styleFile, "utf-8").trim() || null;
  } catch { return null; }
}

/** Compile opening.md as a Handlebars template with variables.json + profile context */
function resolveOpeningPlaceholders(text: string, sessionDir: string, profile?: Profile): string {
  let context: Record<string, unknown> = {};
  // Load variables.json
  const varsPath = path.join(sessionDir, "variables.json");
  if (fs.existsSync(varsPath)) {
    try { context = JSON.parse(fs.readFileSync(varsPath, "utf-8")); } catch { /* ignore */ }
  }
  // Load custom data files (*.json excluding system files)
  try {
    for (const entry of fs.readdirSync(sessionDir)) {
      if (!entry.endsWith(".json") || SYSTEM_JSON.has(entry)) continue;
      const fp = path.join(sessionDir, entry);
      if (fs.statSync(fp).isFile()) {
        try { context[entry.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(fp, "utf-8")); } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
  // Inject user from profile
  context.user = profile?.name ?? context.user ?? "사용자";
  try {
    const template = Handlebars.compile(text, { noEscape: true });
    return template(context, { allowProtoPropertiesByDefault: true });
  } catch {
    // Fallback: return raw text if template compilation fails
    return text;
  }
}

/** System JSON files excluded from custom data file loading */
const SYSTEM_JSON = new Set([
  "variables.json", "session.json", "builder-session.json",
  "comfyui-config.json", "layout.json", "chat-history.json",
  "package.json", "tsconfig.json", "character-tags.json",
  "voice.json", ".mcp.json", "chat-options.json",
  "pending-events.json", "style.json",
]);

export interface PersonaInfo {
  name: string; // directory name
  displayName: string; // from persona.md first line or name
  hasIcon?: boolean;
}

export interface ProfileInfo {
  slug: string;
  name: string;
  isPrimary?: boolean;
}

export interface Profile {
  name: string;
  description: string;
  isPrimary?: boolean;
}

export interface SessionInfo {
  id: string; // directory name
  persona: string;
  displayName: string; // persona display name from persona.md
  title: string;
  createdAt: string;
  hasIcon?: boolean;
  model?: string;
  profileSlug?: string;
}

export interface DataFileInfo {
  name: string;       // filename without extension (e.g. "world")
  filename: string;   // full filename (e.g. "world.json")
  preview: string;    // first 500 chars of content
  keys: string[];     // top-level keys or array length hint
}

export interface PersonaOverview {
  files: Array<{ name: string; exists: boolean; preview: string | null }>;
  panels: string[];
  panelData: Array<{ name: string; html: string }>;
  skills: string[];
  dataFiles: DataFileInfo[];
  hasProfile?: boolean;
  hasIcon?: boolean;
}

export interface LayoutConfig {
  panels: {
    position: "right" | "left" | "bottom" | "hidden";
    size: number;
  };
  chat: {
    maxWidth: number | null;
    align: "stretch" | "center";
  };
  theme: {
    accent: string;
    bg: string;
    surface: string;
    surfaceLight: string;
    userBubble: string;
    assistantBubble: string;
    border: string;
    text: string;
    textDim: string;
  };
  customCSS: string;
}

const DEFAULT_LAYOUT: LayoutConfig = {
  panels: { position: "right", size: 380 },
  chat: { maxWidth: null, align: "stretch" },
  theme: {
    accent: "#7c6fff",
    bg: "#0f0f1a",
    surface: "#16213e",
    surfaceLight: "#1f2f50",
    userBubble: "#2a3a5e",
    assistantBubble: "#1e2d4a",
    border: "#2a3a5e",
    text: "#e8e8f0",
    textDim: "#8888a0",
  },
  customCSS: "",
};

interface SessionMeta {
  persona: string;
  title: string;
  createdAt: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  profileSlug?: string;
  model?: string;
}

interface BuilderMeta {
  claudeSessionId?: string;
  codexThreadId?: string;
  provider?: "claude" | "codex";
}

const CLAUDE_SETTINGS = {
  permissions: {
    allow: [
      "Read",
      "Write(**)",
      "Edit(**)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Bash(mkdir *)",
      "Bash(curl *)",
      "Bash(bash ./*.sh *)",
      "Glob",
      "Grep",
      "mcp__claude_bridge__*",
    ],
  },
};
const SERVICE_SESSION_GUIDE_FILES_CLAUDE = ["session-primer.yaml", "session-shared.md"] as const;
const SERVICE_SESSION_GUIDE_FILES_CODEX = ["session-primer-codex.yaml", "session-shared.md"] as const;
const BUILDER_GUIDE_FILES = ["builder-primer.yaml"] as const;
const MCP_CONFIG_FILE = ".mcp.json";
const CLAUDE_MCP_SERVER_NAME = "claude_bridge";
const POLICY_CONTEXT_FILE = "policy-context.json";
const DEFAULT_POLICY_CONTEXT = {
  extreme_traits: [],
  reviewed_scenarios: [],
  intimacy_policy: {
    allow_moderate_intimacy: true,
    allow_explicit: true,
    max_intensity: "explicit",
  },
  notes: "Roleplay context only. This file never overrides higher-level model policy.",
};

export class SessionManager {
  private dataDir: string;
  private appRoot: string;

  constructor(dataDir: string, appRoot: string) {
    this.dataDir = dataDir;
    this.appRoot = appRoot;
    this.ensureDirs();
  }

  private ensureDirs(): void {
    fs.mkdirSync(path.join(this.dataDir, "personas"), { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, "profiles"), { recursive: true });
  }

  private profilesDir(): string {
    return path.join(this.dataDir, "profiles");
  }

  private personasDir(): string {
    return path.join(this.dataDir, "personas");
  }

  private sessionsDir(): string {
    return path.join(this.dataDir, "sessions");
  }

  // ── Persona ──────────────────────────────────────────────

  listPersonas(): PersonaInfo[] {
    const dir = this.personasDir();
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const personaMd = path.join(dir, d.name, "persona.md");
        let displayName = d.name;
        if (fs.existsSync(personaMd)) {
          const firstLine = fs
            .readFileSync(personaMd, "utf-8")
            .split("\n")[0]
            .replace(/^#\s*/, "")
            .trim();
          if (firstLine) displayName = firstLine;
        }
        const hasIcon = fs.existsSync(path.join(dir, d.name, "images", "icon.png"));
        return { name: d.name, displayName, hasIcon };
      });
  }

  getPersonaDir(name: string): string {
    return path.join(this.personasDir(), name);
  }

  personaExists(name: string): boolean {
    return fs.existsSync(this.getPersonaDir(name));
  }

  getPersonaDisplayName(name: string): string {
    const personaMd = path.join(this.getPersonaDir(name), "persona.md");
    if (fs.existsSync(personaMd)) {
      const firstLine = fs.readFileSync(personaMd, "utf-8").split("\n")[0].replace(/^#\s*/, "").trim();
      if (firstLine) return firstLine;
    }
    return name;
  }

  readPersonaFile(name: string, file: string): string | null {
    const filePath = path.join(this.getPersonaDir(name), file);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  }

  readPersonaOverview(name: string): PersonaOverview {
    try {
      const dir = this.getPersonaDir(name);
      const targetFiles = [
        "persona.md",
        "worldview.md",
        "variables.json",
        "opening.md",
        "session-instructions.md",
        "layout.json",
      ];

      const files = targetFiles.map((f) => {
        const filePath = path.join(dir, f);
        const exists = fs.existsSync(filePath);
        let preview: string | null = null;
        if (exists) {
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            preview = content.slice(0, 500);
          } catch {
            preview = null;
          }
        }
        return { name: f, exists, preview };
      });

      let panels: string[] = [];
      let panelData: Array<{ name: string; html: string }> = [];
      const panelsDir = path.join(dir, "panels");
      if (fs.existsSync(panelsDir)) {
        try {
          const panelFiles = fs
            .readdirSync(panelsDir)
            .filter((f) => f.endsWith(".html"))
            .sort();
          panels = panelFiles;

          // Load variables.json + custom data files for Handlebars rendering
          let context: Record<string, unknown> = {};
          const varsPath = path.join(dir, "variables.json");
          if (fs.existsSync(varsPath)) {
            try {
              context = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
            } catch { /* ignore */ }
          }
          // Load custom data files (*.json excluding system files)
          try {
            for (const entry of fs.readdirSync(dir)) {
              if (!entry.endsWith(".json") || SYSTEM_JSON.has(entry)) continue;
              const fp = path.join(dir, entry);
              if (!fs.statSync(fp).isFile()) continue;
              try {
                context[entry.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(fp, "utf-8"));
              } catch { /* skip */ }
            }
          } catch { /* ignore */ }

          // Inject image base URL for persona context
          context.__imageBase = `/api/personas/${encodeURIComponent(name)}/images?file=`; // images API serves from images/ dir directly
          context.__sessionId = "";

          // Render each panel
          panelData = panelFiles.map((file) => {
            const rawName = file.replace(/\.html$/, "");
            const displayName = rawName.replace(/^\d+-/, "");
            try {
              const source = fs.readFileSync(path.join(panelsDir, file), "utf-8");
              const template = Handlebars.compile(source);
              const html = template(context, { allowProtoPropertiesByDefault: true });
              return { name: displayName, html };
            } catch {
              return { name: displayName, html: `<div style="color:#ff4d6a;padding:8px;">Panel "${displayName}" render error</div>` };
            }
          });
        } catch {
          panels = [];
          panelData = [];
        }
      }

      let skills: string[] = [];
      const skillsDir = path.join(dir, "skills");
      if (fs.existsSync(skillsDir)) {
        try {
          skills = fs
            .readdirSync(skillsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          skills = [];
        }
      }

      // Scan custom data files
      const dataFiles: DataFileInfo[] = [];
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.endsWith(".json") || SYSTEM_JSON.has(entry)) continue;
          const fp = path.join(dir, entry);
          if (!fs.statSync(fp).isFile()) continue;
          try {
            const raw = fs.readFileSync(fp, "utf-8");
            const parsed = JSON.parse(raw);
            const keys = Array.isArray(parsed)
              ? [`Array(${parsed.length})`]
              : typeof parsed === "object" && parsed !== null
                ? Object.keys(parsed)
                : [];
            dataFiles.push({
              name: entry.replace(/\.json$/, ""),
              filename: entry,
              preview: raw.slice(0, 500),
              keys,
            });
          } catch { /* skip malformed */ }
        }
      } catch { /* ignore */ }

      // Check for profile/icon images
      const imagesDir = path.join(dir, "images");
      const hasProfile = fs.existsSync(path.join(imagesDir, "profile.png"));
      const hasIcon = fs.existsSync(path.join(imagesDir, "icon.png"));

      return {
        files, panels, panelData, skills, dataFiles,
        ...(hasProfile ? { hasProfile: true } : {}),
        ...(hasIcon ? { hasIcon: true } : {}),
      };
    } catch {
      return { files: [], panels: [], panelData: [], skills: [], dataFiles: [] };
    }
  }

  // ── Profile ──────────────────────────────────────────────

  private profileSlug(name: string): string {
    return name.trim().replace(/\s+/g, "-");
  }

  listProfiles(): ProfileInfo[] {
    const dir = this.profilesDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(dir, f), "utf-8")
          ) as Profile;
          const info: ProfileInfo = { slug: f.replace(/\.json$/, ""), name: data.name };
          if (data.isPrimary) info.isPrimary = true;
          return info;
        } catch {
          return null;
        }
      })
      .filter((p): p is ProfileInfo => p !== null);
  }

  getProfile(slug: string): Profile | null {
    const filePath = path.join(this.profilesDir(), `${slug}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Profile;
    } catch {
      return null;
    }
  }

  saveProfile(profile: Profile): string {
    const slug = this.profileSlug(profile.name);
    // If setting as primary, clear other profiles' isPrimary
    if (profile.isPrimary) {
      const dir = this.profilesDir();
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
          const fSlug = f.replace(/\.json$/, "");
          if (fSlug === slug) continue;
          const fp = path.join(dir, f);
          try {
            const data = JSON.parse(fs.readFileSync(fp, "utf-8")) as Profile;
            if (data.isPrimary) {
              delete data.isPrimary;
              fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
            }
          } catch { /* skip */ }
        }
      }
    }
    fs.writeFileSync(
      path.join(this.profilesDir(), `${slug}.json`),
      JSON.stringify(profile, null, 2),
      "utf-8"
    );
    return slug;
  }

  deleteProfile(slug: string): void {
    const filePath = path.join(this.profilesDir(), `${slug}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // ── Session ──────────────────────────────────────────────

  createSession(personaName: string, title?: string, profile?: Profile): SessionInfo {
    if (!this.personaExists(personaName)) {
      throw new Error(`Persona "${personaName}" not found`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const id = `${personaName}-${timestamp}`;
    const sessionDir = path.join(this.sessionsDir(), id);

    // Create session directory
    fs.mkdirSync(sessionDir, { recursive: true });

    // Copy persona files to session (excluding builder-only files and CLAUDE.md which is the builder prompt)
    const personaDir = this.getPersonaDir(personaName);
    const SKIP_FILES = new Set(["builder-session.json", "panel-spec.md", "skills", ".claude", "CLAUDE.md", "session-instructions.md", "chat-history.json"]);
    this.copyDirRecursive(personaDir, sessionDir, SKIP_FILES);

    // Copy session-instructions.md as both CLAUDE.md and AGENTS.md for the session
    // Also keep a copy of session-instructions.md in session for accurate sync diff
    const sessionInstructionsSrc = path.join(personaDir, "session-instructions.md");
    if (fs.existsSync(sessionInstructionsSrc)) {
      fs.copyFileSync(sessionInstructionsSrc, path.join(sessionDir, "CLAUDE.md"));
      fs.copyFileSync(sessionInstructionsSrc, path.join(sessionDir, "AGENTS.md"));
      fs.copyFileSync(sessionInstructionsSrc, path.join(sessionDir, "session-instructions.md"));
    }

    // Write session metadata
    const meta: SessionMeta = {
      persona: personaName,
      title: title || this.getPersonaDisplayName(personaName),
      createdAt: new Date().toISOString(),
      ...(profile ? { profileSlug: this.profileSlug(profile.name) } : {}),
    };
    fs.writeFileSync(
      path.join(sessionDir, "session.json"),
      JSON.stringify(meta, null, 2),
      "utf-8"
    );

    // Create Claude runtime configs (.claude/settings.json + .mcp.json)
    this.ensureClaudeRuntimeConfig(sessionDir, personaName, "session");

    // Ensure memory.md exists
    const memoryPath = path.join(sessionDir, "memory.md");
    if (!fs.existsSync(memoryPath)) {
      fs.writeFileSync(memoryPath, "", "utf-8");
    }

    // If writing style is selected, inject into both instruction files
    const styleContent = readPersonaStyleContent(personaDir);
    if (styleContent) {
      const styleSection = `\n\n## __문체 (Writing Style)__\n${styleContent}\n`;
      for (const file of ["CLAUDE.md", "AGENTS.md"]) {
        const mdPath = path.join(sessionDir, file);
        if (fs.existsSync(mdPath)) {
          const existing = fs.readFileSync(mdPath, "utf-8");
          fs.writeFileSync(mdPath, existing + styleSection, "utf-8");
        }
      }
    }

    // If profile is provided, inject user info into both instruction files
    if (profile) {
      const userSection = `\n\n## __사용자 정보__\n사용자의 이름: ${profile.name}\n${profile.description}\n`;
      for (const file of ["CLAUDE.md", "AGENTS.md"]) {
        const mdPath = path.join(sessionDir, file);
        if (fs.existsSync(mdPath)) {
          const existing = fs.readFileSync(mdPath, "utf-8");
          fs.writeFileSync(mdPath, existing + userSection, "utf-8");
        }
      }
    }

    // If opening.md exists, append opening context to both instruction files
    const openingPath = path.join(sessionDir, "opening.md");
    if (fs.existsSync(openingPath)) {
      const rawOpening = fs.readFileSync(openingPath, "utf-8").trim();
      if (rawOpening) {
        const openingContent = resolveOpeningPlaceholders(rawOpening, sessionDir, profile);
        const appendix = `\n\n## __오프닝 메시지__\n아래 메시지는 세션 시작 시 사용자에게 이미 표시되었다. 이 메시지를 반복하지 마라.\n\n${openingContent}\n`;
        for (const file of ["CLAUDE.md", "AGENTS.md"]) {
          const mdPath = path.join(sessionDir, file);
          const existing = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf-8") : "";
          fs.writeFileSync(mdPath, existing + appendix, "utf-8");
        }
      }
    }

    // Copy panel-spec.md from appRoot to sessionDir
    const panelSpecSrc = path.join(this.appRoot, "panel-spec.md");
    if (fs.existsSync(panelSpecSrc)) {
      fs.copyFileSync(panelSpecSrc, path.join(sessionDir, "panel-spec.md"));
    }

    // Copy persona skills/ to both .claude/skills/ and .agents/skills/ (Claude + Codex)
    const personaSkillsSrc = path.join(personaDir, "skills");
    const claudeSkillsDest = path.join(sessionDir, ".claude", "skills");
    const agentsSkillsDest = path.join(sessionDir, ".agents", "skills");
    fs.mkdirSync(claudeSkillsDest, { recursive: true });
    fs.mkdirSync(agentsSkillsDest, { recursive: true });
    if (fs.existsSync(personaSkillsSrc)) {
      this.copyDirRecursive(personaSkillsSrc, claudeSkillsDest);
      this.copyDirRecursive(personaSkillsSrc, agentsSkillsDest);
    }

    // Copy global tool skills (data/tools/*/skills/*) to session
    this.copyToolSkills(claudeSkillsDest);
    this.copyToolSkills(agentsSkillsDest);

    return { id, ...meta, displayName: this.getPersonaDisplayName(personaName) };
  }

  listSessions(): SessionInfo[] {
    const dir = this.sessionsDir();
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const metaPath = path.join(dir, d.name, "session.json");
        if (!fs.existsSync(metaPath)) return null;
        try {
          const meta: SessionMeta = JSON.parse(
            fs.readFileSync(metaPath, "utf-8")
          );
          const iconPath = path.join(dir, d.name, "images", "icon.png");
          const hasIcon = fs.existsSync(iconPath);
          return {
            id: d.name,
            ...meta,
            displayName: this.getPersonaDisplayName(meta.persona),
            ...(hasIcon ? { hasIcon: true } : {}),
            ...(meta.model ? { model: meta.model } : {}),
          };
        } catch {
          return null;
        }
      })
      .filter((s): s is SessionInfo => s !== null)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  }

  getSessionDir(id: string): string {
    return path.join(this.sessionsDir(), id);
  }

  /** Read opening.md and resolve Handlebars placeholders from variables.json + profile */
  resolveOpening(sessionDir: string, profileSlug?: string): string | null {
    const openingPath = path.join(sessionDir, "opening.md");
    if (!fs.existsSync(openingPath)) return null;
    const raw = fs.readFileSync(openingPath, "utf-8").trim();
    if (!raw) return null;
    const profile = profileSlug ? this.getProfile(profileSlug) : undefined;
    return resolveOpeningPlaceholders(raw, sessionDir, profile ?? undefined);
  }

  getSessionInfo(id: string): SessionInfo | null {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return null;
    try {
      const meta: SessionMeta = JSON.parse(
        fs.readFileSync(metaPath, "utf-8")
      );
      return { id, ...meta, displayName: this.getPersonaDisplayName(meta.persona) };
    } catch {
      return null;
    }
  }

  /** Save the Claude session ID into session.json */
  saveClaudeSessionId(id: string, claudeSessionId: string): void {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return;
    try {
      const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      meta.claudeSessionId = claudeSessionId;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    } catch { /* ignore */ }
  }

  /** Save model choice to session */
  saveSessionModel(id: string, model: string): void {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return;
    try {
      const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      meta.model = model || undefined;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    } catch { /* ignore */ }
  }

  /** Get saved model for session */
  getSessionModel(id: string): string | undefined {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      return meta.model;
    } catch {
      return undefined;
    }
  }

  /** Clear saved Claude session ID (e.g. when switching models) */
  clearClaudeSessionId(id: string): void {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return;
    try {
      const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      delete meta.claudeSessionId;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    } catch { /* ignore */ }
  }

  /** Get saved Claude session ID for resume */
  getClaudeSessionId(id: string): string | undefined {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      return meta.claudeSessionId;
    } catch {
      return undefined;
    }
  }

  /** Save Codex thread ID for resume */
  saveCodexThreadId(id: string, threadId: string): void {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return;
    try {
      const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      meta.codexThreadId = threadId;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    } catch { /* ignore */ }
  }

  /** Get saved Codex thread ID for resume */
  getCodexThreadId(id: string): string | undefined {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      const meta: SessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      return meta.codexThreadId;
    } catch {
      return undefined;
    }
  }

  /** Sync updated files from persona to session (panels, variables, opening, layout, skills) */
  /** Full sync — syncs all elements from persona to session */
  syncPersonaToSession(id: string): void {
    const elements: Record<string, boolean> = {
      panels: true, variables: true, layout: true, opening: true,
      worldview: true, skills: true, instructions: true, voice: true,
      chatOptions: true, tools: true, popups: true,
    };
    // Include all custom data files from persona
    const sessionDir = this.getSessionDir(id);
    const metaPath = path.join(sessionDir, "session.json");
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const personaDir = this.getPersonaDir(meta.persona);
      for (const f of this.getCustomDataFiles(personaDir)) {
        elements[`data:${f}`] = true;
      }
    } catch { /* ignore */ }
    this.syncPersonaToSessionSelective(id, elements);
  }

  /** Selective sync — only sync the specified elements */
  syncPersonaToSessionSelective(id: string, elements: Record<string, boolean>): void {
    const sessionDir = this.getSessionDir(id);
    const metaPath = path.join(sessionDir, "session.json");
    if (!fs.existsSync(metaPath)) return;

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch { return; }

    const personaDir = this.getPersonaDir(meta.persona);
    if (!fs.existsSync(personaDir)) return;

    // Sync panels/ directory (overwrite with persona's latest)
    if (elements.panels) {
      const personaPanels = path.join(personaDir, "panels");
      const sessionPanels = path.join(sessionDir, "panels");
      if (fs.existsSync(personaPanels)) {
        if (!fs.existsSync(sessionPanels)) fs.mkdirSync(sessionPanels, { recursive: true });
        for (const file of fs.readdirSync(personaPanels)) {
          const src = path.join(personaPanels, file);
          const dst = path.join(sessionPanels, file);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, dst);
          }
        }
      }
    }

    // Sync popups/ directory
    if (elements.popups) {
      const personaPopups = path.join(personaDir, "popups");
      const sessionPopups = path.join(sessionDir, "popups");
      if (fs.existsSync(personaPopups)) {
        if (!fs.existsSync(sessionPopups)) fs.mkdirSync(sessionPopups, { recursive: true });
        for (const file of fs.readdirSync(personaPopups)) {
          const src = path.join(personaPopups, file);
          const dst = path.join(sessionPopups, file);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, dst);
          }
        }
      }
    }

    // Merge variables.json: add new keys from persona, keep existing session values
    if (elements.variables) {
      const personaVarsPath = path.join(personaDir, "variables.json");
      const sessionVarsPath = path.join(sessionDir, "variables.json");
      if (fs.existsSync(personaVarsPath)) {
        try {
          const personaVars = JSON.parse(fs.readFileSync(personaVarsPath, "utf-8"));
          let sessionVars: Record<string, unknown> = {};
          if (fs.existsSync(sessionVarsPath)) {
            sessionVars = JSON.parse(fs.readFileSync(sessionVarsPath, "utf-8"));
          }
          let changed = false;
          for (const [key, val] of Object.entries(personaVars)) {
            if (!(key in sessionVars)) {
              sessionVars[key] = val;
              changed = true;
            }
          }
          if (changed) {
            fs.writeFileSync(sessionVarsPath, JSON.stringify(sessionVars, null, 2), "utf-8");
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // Individual overwrite-safe files
    const fileMap: Record<string, string> = {
      layout: "layout.json",
      opening: "opening.md",
      worldview: "worldview.md",
      voice: "voice.json",
      chatOptions: "chat-options.json",
    };
    for (const [key, file] of Object.entries(fileMap)) {
      if (elements[key]) {
        const src = path.join(personaDir, file);
        const dst = path.join(sessionDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
        }
      }
    }

    // Sync voice/ directory (contains .pt voice embeddings)
    if (elements.voice) {
      const personaVoiceDir = path.join(personaDir, "voice");
      const sessionVoiceDir = path.join(sessionDir, "voice");
      if (fs.existsSync(personaVoiceDir)) {
        if (!fs.existsSync(sessionVoiceDir)) fs.mkdirSync(sessionVoiceDir, { recursive: true });
        for (const file of fs.readdirSync(personaVoiceDir)) {
          const src = path.join(personaVoiceDir, file);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, path.join(sessionVoiceDir, file));
          }
        }
      }
    }

    // Sync character-tags.json
    if (elements.characterTags) {
      const src = path.join(personaDir, "character-tags.json");
      const dst = path.join(sessionDir, "character-tags.json");
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }

    // Sync custom data files (individual per-file keys: data:filename.json)
    for (const [key, enabled] of Object.entries(elements)) {
      if (!enabled || !key.startsWith("data:")) continue;
      const f = key.slice("data:".length);
      const src = path.join(personaDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(sessionDir, f));
      }
    }

    // Sync tools/ (custom panel tools — *.js files only)
    if (elements.tools) {
      const personaTools = path.join(personaDir, "tools");
      const sessionTools = path.join(sessionDir, "tools");
      if (fs.existsSync(personaTools)) {
        if (!fs.existsSync(sessionTools)) fs.mkdirSync(sessionTools, { recursive: true });
        for (const file of fs.readdirSync(personaTools)) {
          if (file.endsWith(".js")) {
            fs.copyFileSync(path.join(personaTools, file), path.join(sessionTools, file));
          }
        }
      }
    }

    // Sync skills/ directory (raw copy + both CLI skill dirs)
    if (elements.skills) {
      const personaSkills = path.join(personaDir, "skills");
      const targets = [
        path.join(sessionDir, "skills"),
        path.join(sessionDir, ".claude", "skills"),
        path.join(sessionDir, ".agents", "skills"),
      ];
      if (fs.existsSync(personaSkills)) {
        for (const targetDir of targets) {
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          for (const entry of fs.readdirSync(personaSkills, { withFileTypes: true })) {
            const src = path.join(personaSkills, entry.name);
            const dst = path.join(targetDir, entry.name);
            if (entry.isDirectory()) {
              this.copyDirRecursive(src, dst);
            } else {
              fs.copyFileSync(src, dst);
            }
          }
        }
      }
    }

    // Refresh instruction files (session-instructions.md + CLAUDE.md / AGENTS.md)
    if (elements.instructions) {
      // Copy raw session-instructions.md to session for future diff comparison
      const instrSrc = path.join(personaDir, "session-instructions.md");
      if (fs.existsSync(instrSrc)) {
        fs.copyFileSync(instrSrc, path.join(sessionDir, "session-instructions.md"));
      }
      this.refreshSessionInstructionFiles(id);
    }
  }

  /** Compare persona vs session to show what's different */
  getSyncDiff(id: string): Array<{ key: string; label: string; hasChanges: boolean }> {
    const sessionDir = this.getSessionDir(id);
    const metaPath = path.join(sessionDir, "session.json");
    if (!fs.existsSync(metaPath)) return [];

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch { return []; }

    const personaDir = this.getPersonaDir(meta.persona);
    if (!fs.existsSync(personaDir)) return [];

    const result: Array<{ key: string; label: string; hasChanges: boolean }> = [];

    // Check panels
    const pPanels = path.join(personaDir, "panels");
    const sPanels = path.join(sessionDir, "panels");
    result.push({ key: "panels", label: "패널 (panels/)", hasChanges: this.dirDiffers(pPanels, sPanels) });

    // Check popups
    const pPopups = path.join(personaDir, "popups");
    const sPopups = path.join(sessionDir, "popups");
    result.push({ key: "popups", label: "팝업 (popups/)", hasChanges: this.dirDiffers(pPopups, sPopups) });

    // Check individual files
    const files: Array<{ key: string; label: string; file: string }> = [
      { key: "layout", label: "레이아웃 (layout.json)", file: "layout.json" },
      { key: "opening", label: "오프닝 메시지 (opening.md)", file: "opening.md" },
      { key: "worldview", label: "세계관 (worldview.md)", file: "worldview.md" },
      { key: "variables", label: "변수 (variables.json)", file: "variables.json" },
      { key: "voice", label: "음성 설정 (voice.json)", file: "voice.json" },
    ];
    for (const { key, label, file } of files) {
      const src = path.join(personaDir, file);
      const dst = path.join(sessionDir, file);
      if (key === "variables") {
        // For variables, check if persona has keys not in session
        result.push({ key, label, hasChanges: this.variablesDiffer(src, dst) });
      } else if (key === "voice") {
        // For voice, also compare voice/ directory (contains .pt files)
        const fileDiff = this.fileDiffers(src, dst);
        const dirDiff = this.dirDiffers(path.join(personaDir, "voice"), path.join(sessionDir, "voice"));
        result.push({ key, label: "음성 설정 (voice.json + voice/)", hasChanges: fileDiff || dirDiff });
      } else {
        result.push({ key, label, hasChanges: this.fileDiffers(src, dst) });
      }
    }

    // Check tools (custom panel tools — *.js files only)
    result.push({ key: "tools", label: "툴 (tools/)", hasChanges: this.toolsDiffer(path.join(personaDir, "tools"), path.join(sessionDir, "tools")) });

    // Check skills
    const pSkills = path.join(personaDir, "skills");
    const sSkills = path.join(sessionDir, "skills");
    result.push({ key: "skills", label: "스킬 (skills/)", hasChanges: this.dirDiffers(pSkills, sSkills) });

    // Check instructions — compare persona's raw file vs session's live CLAUDE.md/AGENTS.md (stripped)
    {
      const provider = meta.model ? providerFromModel(meta.model) : "claude";
      const liveFile = provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
      const liveInstrPath = path.join(sessionDir, liveFile);
      const instrSrc = path.join(personaDir, "session-instructions.md");
      // Reverse args: compare live (session) against raw (persona)
      result.push({ key: "instructions", label: `인스트럭션 (session-instructions.md → ${liveFile})`, hasChanges: this.liveInstructionsDiffer(liveInstrPath, instrSrc) });
    }

    // Check character-tags.json
    const pCharTags = path.join(personaDir, "character-tags.json");
    const sCharTags = path.join(sessionDir, "character-tags.json");
    result.push({ key: "characterTags", label: "캐릭터 태그 (character-tags.json)", hasChanges: this.fileDiffers(pCharTags, sCharTags) });

    // Check chat options
    result.push({ key: "chatOptions", label: "채팅 옵션 (chat-options.json)", hasChanges: this.fileDiffers(path.join(personaDir, "chat-options.json"), path.join(sessionDir, "chat-options.json")) });

    // Check custom data files individually (*.json excluding system files)
    const allDataFiles = new Set([
      ...this.getCustomDataFiles(personaDir),
      ...this.getCustomDataFiles(sessionDir),
    ]);
    for (const f of [...allDataFiles].sort()) {
      const key = `data:${f}`;
      result.push({ key, label: f, hasChanges: this.fileDiffers(path.join(personaDir, f), path.join(sessionDir, f)) });
    }

    return result;
  }

  /** Compare session vs persona to show what session has changed (reverse direction) */
  getReverseSyncDiff(id: string): Array<{ key: string; label: string; hasChanges: boolean }> {
    const sessionDir = this.getSessionDir(id);
    const metaPath = path.join(sessionDir, "session.json");
    if (!fs.existsSync(metaPath)) return [];

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch { return []; }

    const personaDir = this.getPersonaDir(meta.persona);
    if (!fs.existsSync(personaDir)) return [];

    const result: Array<{ key: string; label: string; hasChanges: boolean }> = [];

    // Check panels (session → persona direction)
    const sPanels = path.join(sessionDir, "panels");
    const pPanels = path.join(personaDir, "panels");
    result.push({ key: "panels", label: "패널 (panels/)", hasChanges: this.dirDiffers(sPanels, pPanels) });

    // Check popups (session → persona direction)
    const sPopups = path.join(sessionDir, "popups");
    const pPopups = path.join(personaDir, "popups");
    result.push({ key: "popups", label: "팝업 (popups/)", hasChanges: this.dirDiffers(sPopups, pPopups) });

    // Check individual files
    const files: Array<{ key: string; label: string; file: string }> = [
      { key: "layout", label: "레이아웃 (layout.json)", file: "layout.json" },
      { key: "opening", label: "오프닝 메시지 (opening.md)", file: "opening.md" },
      { key: "worldview", label: "세계관 (worldview.md)", file: "worldview.md" },
      { key: "variables", label: "변수 (variables.json)", file: "variables.json" },
      { key: "voice", label: "음성 설정 (voice.json)", file: "voice.json" },
    ];
    for (const { key, label, file } of files) {
      const src = path.join(sessionDir, file);
      const dst = path.join(personaDir, file);
      if (key === "voice") {
        const fileDiff = this.fileDiffers(src, dst);
        const dirDiff = this.dirDiffers(path.join(sessionDir, "voice"), path.join(personaDir, "voice"));
        result.push({ key, label: "음성 설정 (voice.json + voice/)", hasChanges: fileDiff || dirDiff });
      } else {
        result.push({ key, label, hasChanges: this.fileDiffers(src, dst) });
      }
    }

    // Check tools (reverse direction)
    result.push({ key: "tools", label: "툴 (tools/)", hasChanges: this.toolsDiffer(path.join(sessionDir, "tools"), path.join(personaDir, "tools")) });

    // Check skills
    const sSkills = path.join(sessionDir, "skills");
    const pSkills = path.join(personaDir, "skills");
    result.push({ key: "skills", label: "스킬 (skills/)", hasChanges: this.dirDiffers(sSkills, pSkills) });

    // Check instructions — compare live CLAUDE.md/AGENTS.md (stripped of assembled sections) vs persona's raw file
    const instrDst = path.join(personaDir, "session-instructions.md");
    const provider = meta.model ? providerFromModel(meta.model) : "claude";
    const liveFile = provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
    const liveInstrPath = path.join(sessionDir, liveFile);
    const instrChanged = this.liveInstructionsDiffer(liveInstrPath, instrDst);
    result.push({ key: "instructions", label: `인스트럭션 (${liveFile} → session-instructions.md)`, hasChanges: instrChanged });

    // Check character-tags.json
    const sCharTags = path.join(sessionDir, "character-tags.json");
    const pCharTags = path.join(personaDir, "character-tags.json");
    result.push({ key: "characterTags", label: "캐릭터 태그 (character-tags.json)", hasChanges: this.fileDiffers(sCharTags, pCharTags) });

    // Check chat options
    result.push({ key: "chatOptions", label: "채팅 옵션 (chat-options.json)", hasChanges: this.fileDiffers(path.join(sessionDir, "chat-options.json"), path.join(personaDir, "chat-options.json")) });

    // Check custom data files individually
    const allDataFiles = new Set([
      ...this.getCustomDataFiles(personaDir),
      ...this.getCustomDataFiles(sessionDir),
    ]);
    for (const f of [...allDataFiles].sort()) {
      const key = `data:${f}`;
      result.push({ key, label: f, hasChanges: this.fileDiffers(path.join(sessionDir, f), path.join(personaDir, f)) });
    }

    return result;
  }

  /** Reverse sync — copy selected elements from session back to persona */
  syncSessionToPersonaSelective(
    id: string,
    elements: Record<string, boolean>,
    variablesMode?: "merge" | "overwrite" | "skip"
  ): void {
    const sessionDir = this.getSessionDir(id);
    const metaPath = path.join(sessionDir, "session.json");
    if (!fs.existsSync(metaPath)) return;

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch { return; }

    const personaDir = this.getPersonaDir(meta.persona);
    if (!fs.existsSync(personaDir)) return;

    // Sync panels/ (session → persona)
    if (elements.panels) {
      const sessionPanels = path.join(sessionDir, "panels");
      const personaPanels = path.join(personaDir, "panels");
      if (fs.existsSync(sessionPanels)) {
        if (!fs.existsSync(personaPanels)) fs.mkdirSync(personaPanels, { recursive: true });
        for (const file of fs.readdirSync(sessionPanels)) {
          const src = path.join(sessionPanels, file);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, path.join(personaPanels, file));
          }
        }
      }
    }

    // Sync popups/ (session → persona)
    if (elements.popups) {
      const sessionPopups = path.join(sessionDir, "popups");
      const personaPopups = path.join(personaDir, "popups");
      if (fs.existsSync(sessionPopups)) {
        if (!fs.existsSync(personaPopups)) fs.mkdirSync(personaPopups, { recursive: true });
        for (const file of fs.readdirSync(sessionPopups)) {
          const src = path.join(sessionPopups, file);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, path.join(personaPopups, file));
          }
        }
      }
    }

    // Sync variables.json with mode selection
    if (elements.variables && variablesMode !== "skip") {
      const sessionVarsPath = path.join(sessionDir, "variables.json");
      const personaVarsPath = path.join(personaDir, "variables.json");
      if (fs.existsSync(sessionVarsPath)) {
        try {
          const sessionVars = JSON.parse(fs.readFileSync(sessionVarsPath, "utf-8"));
          if (variablesMode === "overwrite") {
            fs.writeFileSync(personaVarsPath, JSON.stringify(sessionVars, null, 2), "utf-8");
          } else {
            // "merge" (default) — add new keys only, keep existing persona values
            let personaVars: Record<string, unknown> = {};
            if (fs.existsSync(personaVarsPath)) {
              personaVars = JSON.parse(fs.readFileSync(personaVarsPath, "utf-8"));
            }
            let changed = false;
            for (const [key, val] of Object.entries(sessionVars)) {
              if (!(key in personaVars)) {
                personaVars[key] = val;
                changed = true;
              }
            }
            if (changed) {
              fs.writeFileSync(personaVarsPath, JSON.stringify(personaVars, null, 2), "utf-8");
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // Individual files (session → persona)
    const fileMap: Record<string, string> = {
      layout: "layout.json",
      opening: "opening.md",
      worldview: "worldview.md",
      voice: "voice.json",
      chatOptions: "chat-options.json",
    };
    for (const [key, file] of Object.entries(fileMap)) {
      if (elements[key]) {
        const src = path.join(sessionDir, file);
        const dst = path.join(personaDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
        }
      }
    }

    // Sync voice/ directory (session → persona)
    if (elements.voice) {
      const sessionVoiceDir = path.join(sessionDir, "voice");
      const personaVoiceDir = path.join(personaDir, "voice");
      if (fs.existsSync(sessionVoiceDir)) {
        if (!fs.existsSync(personaVoiceDir)) fs.mkdirSync(personaVoiceDir, { recursive: true });
        for (const file of fs.readdirSync(sessionVoiceDir)) {
          const src = path.join(sessionVoiceDir, file);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, path.join(personaVoiceDir, file));
          }
        }
      }
    }

    // Sync tools/ (session → persona, *.js files only)
    if (elements.tools) {
      const sessionTools = path.join(sessionDir, "tools");
      const personaTools = path.join(personaDir, "tools");
      if (fs.existsSync(sessionTools)) {
        if (!fs.existsSync(personaTools)) fs.mkdirSync(personaTools, { recursive: true });
        for (const file of fs.readdirSync(sessionTools)) {
          if (file.endsWith(".js")) {
            fs.copyFileSync(path.join(sessionTools, file), path.join(personaTools, file));
          }
        }
      }
    }

    // Sync skills/ (session → persona)
    if (elements.skills) {
      const sessionSkills = path.join(sessionDir, "skills");
      const personaSkills = path.join(personaDir, "skills");
      if (fs.existsSync(sessionSkills)) {
        if (!fs.existsSync(personaSkills)) fs.mkdirSync(personaSkills, { recursive: true });
        for (const entry of fs.readdirSync(sessionSkills, { withFileTypes: true })) {
          const src = path.join(sessionSkills, entry.name);
          const dst = path.join(personaSkills, entry.name);
          if (entry.isDirectory()) {
            this.copyDirRecursive(src, dst);
          } else {
            fs.copyFileSync(src, dst);
          }
        }
      }
    }

    // Sync instructions (session's live CLAUDE.md/AGENTS.md → persona's session-instructions.md)
    // Strip auto-assembled sections (profile, opening) before saving
    if (elements.instructions) {
      const provider = meta.model ? providerFromModel(meta.model) : "claude";
      const liveFile = provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
      const src = path.join(sessionDir, liveFile);
      const dst = path.join(personaDir, "session-instructions.md");
      if (fs.existsSync(src)) {
        let content = fs.readFileSync(src, "utf-8");
        // Remove auto-assembled sections (appended during session creation / refresh)
        content = content.replace(/\n\n## __사용자 정보__\n[\s\S]*?(?=\n\n## |\s*$)/, "");
        content = content.replace(/\n\n## __오프닝 메시지__\n[\s\S]*$/, "");
        fs.writeFileSync(dst, content.trimEnd() + "\n", "utf-8");
      }
    }

    // Sync character-tags.json
    if (elements.characterTags) {
      const src = path.join(sessionDir, "character-tags.json");
      const dst = path.join(personaDir, "character-tags.json");
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }

    // Sync custom data files (individual per-file keys: data:filename.json)
    for (const [key, enabled] of Object.entries(elements)) {
      if (!enabled || !key.startsWith("data:")) continue;
      const f = key.slice("data:".length);
      const src = path.join(sessionDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(personaDir, f));
      }
    }
  }

  private fileDiffers(src: string, dst: string): boolean {
    if (!fs.existsSync(src)) return false;
    if (!fs.existsSync(dst)) return true;
    try {
      const a = fs.readFileSync(src);
      const b = fs.readFileSync(dst);
      return !a.equals(b);
    } catch { return true; }
  }

  private dirDiffers(src: string, dst: string): boolean {
    if (!fs.existsSync(src)) return false;
    if (!fs.existsSync(dst)) return true;
    try {
      const srcFiles = fs.readdirSync(src).filter(f => {
        try { return fs.statSync(path.join(src, f)).isFile(); } catch { return false; }
      });
      for (const file of srcFiles) {
        if (this.fileDiffers(path.join(src, file), path.join(dst, file))) return true;
      }
      return false;
    } catch { return true; }
  }

  /** Compare tools/ directories (*.js files only) */
  private toolsDiffer(dir1: string, dir2: string): boolean {
    if (!fs.existsSync(dir1) && !fs.existsSync(dir2)) return false;
    if (!fs.existsSync(dir1) || !fs.existsSync(dir2)) return true;
    const jsFiles1 = fs.readdirSync(dir1).filter(f => f.endsWith(".js")).sort();
    const jsFiles2 = fs.readdirSync(dir2).filter(f => f.endsWith(".js")).sort();
    if (jsFiles1.length !== jsFiles2.length) return true;
    for (let i = 0; i < jsFiles1.length; i++) {
      if (jsFiles1[i] !== jsFiles2[i]) return true;
      if (this.fileDiffers(path.join(dir1, jsFiles1[i]), path.join(dir2, jsFiles2[i]))) return true;
    }
    return false;
  }

  private variablesDiffer(src: string, dst: string): boolean {
    if (!fs.existsSync(src)) return false;
    try {
      const personaVars = JSON.parse(fs.readFileSync(src, "utf-8"));
      const sessionVars = fs.existsSync(dst) ? JSON.parse(fs.readFileSync(dst, "utf-8")) : {};
      for (const key of Object.keys(personaVars)) {
        if (!(key in sessionVars)) return true;
      }
      return false;
    } catch { return false; }
  }

  /** Compare live instruction file (with assembled sections stripped) against raw persona file */
  private liveInstructionsDiffer(livePath: string, rawPath: string): boolean {
    if (!fs.existsSync(livePath)) return false;
    if (!fs.existsSync(rawPath)) return true;
    try {
      let live = fs.readFileSync(livePath, "utf-8");
      live = live.replace(/\n\n## __사용자 정보__\n[\s\S]*?(?=\n\n## |\s*$)/, "");
      live = live.replace(/\n\n## __오프닝 메시지__\n[\s\S]*$/, "");
      live = live.trimEnd() + "\n";
      const raw = fs.readFileSync(rawPath, "utf-8");
      return live !== raw;
    } catch { return true; }
  }

  /** List custom data file names (*.json excluding system files) in a directory */
  private getCustomDataFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir).filter(f => {
        if (!f.endsWith(".json") || SYSTEM_JSON.has(f)) return false;
        try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
      });
    } catch { return []; }
  }

  deleteSession(id: string): void {
    const dir = this.getSessionDir(id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Regenerate CLAUDE.md and AGENTS.md from persona's latest session-instructions.md */
  refreshSessionInstructionFiles(id: string): void {
    const sessionDir = this.getSessionDir(id);
    const metaPath = path.join(sessionDir, "session.json");
    if (!fs.existsSync(metaPath)) return;

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch { return; }

    const personaDir = this.getPersonaDir(meta.persona);
    if (!fs.existsSync(personaDir)) return;

    // 1. Copy latest session-instructions.md as both CLAUDE.md and AGENTS.md
    const instructionsSrc = path.join(personaDir, "session-instructions.md");
    if (!fs.existsSync(instructionsSrc)) return;

    const targets = ["CLAUDE.md", "AGENTS.md"];
    for (const file of targets) {
      fs.copyFileSync(instructionsSrc, path.join(sessionDir, file));
    }

    // 2. Re-inject writing style if selected
    const styleContent = readPersonaStyleContent(personaDir);
    if (styleContent) {
      const styleSection = `\n\n## __문체 (Writing Style)__\n${styleContent}\n`;
      for (const file of targets) {
        const mdPath = path.join(sessionDir, file);
        const existing = fs.readFileSync(mdPath, "utf-8");
        fs.writeFileSync(mdPath, existing + styleSection, "utf-8");
      }
    }

    // 3. Re-inject profile info if session had one
    if (meta.profileSlug) {
      const profile = this.getProfile(meta.profileSlug);
      if (profile) {
        const userSection = `\n\n## __사용자 정보__\n사용자의 이름: ${profile.name}\n${profile.description}\n`;
        for (const file of targets) {
          const mdPath = path.join(sessionDir, file);
          const existing = fs.readFileSync(mdPath, "utf-8");
          fs.writeFileSync(mdPath, existing + userSection, "utf-8");
        }
      }
    }

    // 4. Re-append opening context (with placeholder resolution)
    const openingPath = path.join(sessionDir, "opening.md");
    if (fs.existsSync(openingPath)) {
      const rawOpening = fs.readFileSync(openingPath, "utf-8").trim();
      if (rawOpening) {
        const profile = meta.profileSlug ? this.getProfile(meta.profileSlug) : undefined;
        const openingContent = resolveOpeningPlaceholders(rawOpening, sessionDir, profile ?? undefined);
        const appendix = `\n\n## __오프닝 메시지__\n아래 메시지는 세션 시작 시 사용자에게 이미 표시되었다. 이 메시지를 반복하지 마라.\n\n${openingContent}\n`;
        for (const file of targets) {
          const mdPath = path.join(sessionDir, file);
          const existing = fs.readFileSync(mdPath, "utf-8");
          fs.writeFileSync(mdPath, existing + appendix, "utf-8");
        }
      }
    }

    // 5. Ensure runtime configs exist for legacy sessions
    this.ensureClaudeRuntimeConfig(sessionDir, meta.persona, "session");
  }

  /** @deprecated Use refreshSessionInstructionFiles instead */
  refreshSessionClaudeMd(id: string): void {
    this.refreshSessionInstructionFiles(id);
  }

  // ── Persona Builder ─────────────────────────────────────

  /** Create an empty persona directory for the builder session */
  createPersonaDir(name: string): string {
    const dir = this.getPersonaDir(name);
    if (fs.existsSync(dir)) {
      throw new Error(`Persona "${name}" already exists`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "panels"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });

    // Copy global comfyui-config.json as default if it exists
    const globalComfyConfig = path.join(this.appRoot, "data", "tools", "comfyui", "comfyui-config.json");
    if (fs.existsSync(globalComfyConfig)) {
      fs.copyFileSync(globalComfyConfig, path.join(dir, "comfyui-config.json"));
    }

    // Place Claude runtime configs for builder sessions
    this.ensureClaudeRuntimeConfig(dir, name, "builder");

    return dir;
  }

  /** Read the builder meta-prompt, compiled with Handlebars for conditional sections */
  getBuilderPrompt(context: { localTtsAvailable?: boolean } = {}): string {
    const promptPath = path.join(this.appRoot, "builder-prompt.md");
    const source = fs.readFileSync(promptPath, "utf-8");
    const template = Handlebars.compile(source, { noEscape: true });
    return template(context);
  }

  /** Save builder session info for resume */
  saveBuilderSession(name: string, provider: "claude" | "codex", sessionId: string): void {
    const metaPath = path.join(this.getPersonaDir(name), "builder-session.json");
    let meta: BuilderMeta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch { /* */ }
    }
    meta.provider = provider;
    if (provider === "codex") {
      meta.codexThreadId = sessionId;
    } else {
      meta.claudeSessionId = sessionId;
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  /** Get saved builder session ID for resume (provider-aware) */
  getBuilderSessionId(name: string, provider?: "claude" | "codex"): string | undefined {
    const metaPath = path.join(this.getPersonaDir(name), "builder-session.json");
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      const meta: BuilderMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const p = provider || meta.provider || "claude";
      return p === "codex" ? meta.codexThreadId : meta.claudeSessionId;
    } catch {
      return undefined;
    }
  }

  /** Get saved builder provider */
  getBuilderProvider(name: string): "claude" | "codex" | undefined {
    const metaPath = path.join(this.getPersonaDir(name), "builder-session.json");
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      const meta: BuilderMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      return meta.provider;
    } catch {
      return undefined;
    }
  }

  /** Check if a persona has a builder session that can be resumed */
  hasBuilderSession(name: string): boolean {
    return !!this.getBuilderSessionId(name);
  }

  /** Delete an incomplete persona (e.g. builder was cancelled) */
  deletePersona(name: string): void {
    const dir = this.getPersonaDir(name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── Layout ──────────────────────────────────────────────

  readLayout(dir: string): LayoutConfig {
    const layoutPath = path.join(dir, "layout.json");
    if (!fs.existsSync(layoutPath)) return { ...DEFAULT_LAYOUT };
    try {
      const raw = JSON.parse(fs.readFileSync(layoutPath, "utf-8"));
      return {
        panels: { ...DEFAULT_LAYOUT.panels, ...(raw.panels || {}) },
        chat: { ...DEFAULT_LAYOUT.chat, ...(raw.chat || {}) },
        theme: { ...DEFAULT_LAYOUT.theme, ...(raw.theme || {}) },
        customCSS: raw.customCSS ?? DEFAULT_LAYOUT.customCSS,
      };
    } catch {
      return { ...DEFAULT_LAYOUT };
    }
  }

  // ── Voice ──────────────────────────────────────────────

  /** Read voice.json from a directory (persona or session) */
  readVoiceConfig(dir: string): { enabled: boolean; ttsProvider?: "comfyui" | "edge" | "local"; edgeVoice?: string; edgeRate?: string; edgePitch?: string; referenceAudio?: string; referenceText?: string; design?: string; language?: string; speed?: number; modelSize?: string; speaker?: string; voiceFile?: string; chunkDelay?: number } | null {
    const voicePath = path.join(dir, "voice.json");
    if (!fs.existsSync(voicePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(voicePath, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Write voice.json to a directory */
  writeVoiceConfig(dir: string, config: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, "voice.json"), JSON.stringify(config, null, 2), "utf-8");
  }

  // ── Chat Options ──────────────────────────────────────

  /** Read chat-options-schema.json from data dir */
  readOptionsSchema(): Record<string, unknown>[] {
    const schemaPath = path.join(getDataDir(), "chat-options-schema.json");
    if (!fs.existsSync(schemaPath)) return [];
    try { return JSON.parse(fs.readFileSync(schemaPath, "utf-8")); } catch { return []; }
  }

  /** Read chat-options.json from a directory */
  readOptions(dir: string): Record<string, unknown> {
    const optPath = path.join(dir, "chat-options.json");
    if (!fs.existsSync(optPath)) return {};
    try { return JSON.parse(fs.readFileSync(optPath, "utf-8")); } catch { return {}; }
  }

  /** Write chat-options.json to a directory */
  writeOptions(dir: string, options: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, "chat-options.json"), JSON.stringify(options, null, 2), "utf-8");
  }

  /** Resolve options: schema defaults → persona overrides → session overrides */
  resolveOptions(sessionDir: string): Record<string, unknown> {
    const schema = this.readOptionsSchema();
    const defaults: Record<string, unknown> = {};
    for (const opt of schema) {
      defaults[(opt as { key: string }).key] = (opt as { default: unknown }).default;
    }

    // Persona overrides
    const metaPath = path.join(sessionDir, "session.json");
    let personaOverrides: Record<string, unknown> = {};
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.persona) {
        personaOverrides = this.readOptions(this.getPersonaDir(meta.persona));
      }
    } catch { /* ignore */ }

    // Session overrides
    const sessionOverrides = this.readOptions(sessionDir);

    return { ...defaults, ...personaOverrides, ...sessionOverrides };
  }

  // ── Tools ──────────────────────────────────────────────

  /** Re-copy global tool skills into an existing session (called on session open/resume) */
  /** Copy latest panel-spec.md from project root to session */
  refreshPanelSpec(sessionDir: string): void {
    const src = path.join(this.appRoot, "panel-spec.md");
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(sessionDir, "panel-spec.md"));
    }
  }

  refreshToolSkills(sessionDir: string): void {
    const claudeSkillsDest = path.join(sessionDir, ".claude", "skills");
    const agentsSkillsDest = path.join(sessionDir, ".agents", "skills");
    fs.mkdirSync(claudeSkillsDest, { recursive: true });
    fs.mkdirSync(agentsSkillsDest, { recursive: true });
    this.copyToolSkills(claudeSkillsDest);
    this.copyToolSkills(agentsSkillsDest);
  }

  /** Copy skills from all global tools (data/tools/X/skills/) into the session skills dir */
  private copyToolSkills(skillsDest: string): void {
    const toolsDir = path.join(getDataDir(), "tools");
    if (!fs.existsSync(toolsDir)) return;

    const port = process.env.PORT || "3340";

    for (const toolEntry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (!toolEntry.isDirectory()) continue;
      const toolSkillsDir = path.join(toolsDir, toolEntry.name, "skills");
      if (!fs.existsSync(toolSkillsDir)) continue;

      for (const skillEntry of fs.readdirSync(toolSkillsDir, { withFileTypes: true })) {
        if (!skillEntry.isDirectory()) continue;
        const src = path.join(toolSkillsDir, skillEntry.name);
        const dest = path.join(skillsDest, skillEntry.name);
        fs.mkdirSync(dest, { recursive: true });
        this.copyDirRecursive(src, dest);

        // Replace {{PORT}} in SKILL.md and shell scripts
        for (const file of fs.readdirSync(dest)) {
          const filePath = path.join(dest, file);
          if (file === "SKILL.md" || file.endsWith(".sh")) {
            let content = fs.readFileSync(filePath, "utf-8");
            content = content.replace(/\{\{PORT\}\}/g, port);
            fs.writeFileSync(filePath, content, "utf-8");
          }
        }
      }
    }
  }

  ensureClaudeRuntimeConfig(
    projectDir: string,
    personaName?: string,
    mode: "builder" | "session" = "session"
  ): void {
    this.writeClaudeSettings(projectDir);
    this.writeMcpConfig(projectDir, personaName, mode);
    this.writeCodexConfig(projectDir, personaName, mode);
    this.ensurePolicyContext(projectDir);
  }

  private writeClaudeSettings(projectDir: string): void {
    const claudeDir = path.join(projectDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(CLAUDE_SETTINGS, null, 2),
      "utf-8"
    );
  }

  private writeMcpConfig(
    projectDir: string,
    personaName?: string,
    mode: "builder" | "session" = "session"
  ): void {
    const serverScript = path.join(this.appRoot, "src", "mcp", "claude-bridge-mcp-server.mjs");
    const apiBase = (process.env.CLAUDE_BRIDGE_API_BASE || `http://127.0.0.1:${process.env.PORT || "3340"}`)
      .replace(/\/+$/, "");

    const mcpConfig = {
      mcpServers: {
        [CLAUDE_MCP_SERVER_NAME]: {
          command: "node",
          args: [serverScript],
          env: {
            CLAUDE_BRIDGE_API_BASE: apiBase,
            CLAUDE_BRIDGE_SESSION_DIR: projectDir,
            CLAUDE_BRIDGE_MODE: mode,
            CLAUDE_BRIDGE_AUTH_TOKEN: getInternalToken(),
            ...(personaName ? { CLAUDE_BRIDGE_PERSONA: personaName } : {}),
          },
        },
      },
    };

    fs.writeFileSync(
      path.join(projectDir, MCP_CONFIG_FILE),
      JSON.stringify(mcpConfig, null, 2),
      "utf-8"
    );
  }

  /** Write .codex/config.toml with MCP server config + model_instructions_file for Codex CLI */
  private writeCodexConfig(
    projectDir: string,
    personaName?: string,
    mode: "builder" | "session" = "session"
  ): void {
    const codexDir = path.join(projectDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });

    const serverScript = path.join(this.appRoot, "src", "mcp", "claude-bridge-mcp-server.mjs");
    const apiBase = (process.env.CLAUDE_BRIDGE_API_BASE || `http://127.0.0.1:${process.env.PORT || "3340"}`)
      .replace(/\/+$/, "");

    // model_instructions_file: absolute path to instructions file
    const instructionsPath = path.join(codexDir, "model-instructions.md");

    // Build TOML content
    const lines: string[] = [];
    lines.push(`model_instructions_file = ${JSON.stringify(instructionsPath)}`);
    lines.push(``);
    lines.push(`[mcp_servers.${CLAUDE_MCP_SERVER_NAME}]`);
    lines.push(`command = "node"`);
    lines.push(`args = [${JSON.stringify(serverScript)}]`);
    lines.push(``);
    lines.push(`[mcp_servers.${CLAUDE_MCP_SERVER_NAME}.env]`);
    lines.push(`CLAUDE_BRIDGE_API_BASE = ${JSON.stringify(apiBase)}`);
    lines.push(`CLAUDE_BRIDGE_SESSION_DIR = ${JSON.stringify(projectDir)}`);
    lines.push(`CLAUDE_BRIDGE_MODE = ${JSON.stringify(mode)}`);
    lines.push(`CLAUDE_BRIDGE_AUTH_TOKEN = ${JSON.stringify(getInternalToken())}`);
    if (personaName) {
      lines.push(`CLAUDE_BRIDGE_PERSONA = ${JSON.stringify(personaName)}`);
    }

    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      lines.join("\n") + "\n",
      "utf-8"
    );
  }

  /**
   * Write Codex model instructions file (.codex/model-instructions.md).
   * Called before spawning Codex to ensure file-based prompt delivery.
   */
  writeCodexInstructions(projectDir: string, content: string): void {
    const codexDir = path.join(projectDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const instructionsPath = path.join(codexDir, "model-instructions.md");
    fs.writeFileSync(instructionsPath, content, "utf-8");
    console.log(`[codex] Wrote model instructions: ${instructionsPath} (${content.length} chars)`);
  }

  private ensurePolicyContext(projectDir: string): void {
    const policyPath = path.join(projectDir, POLICY_CONTEXT_FILE);
    if (!fs.existsSync(policyPath)) {
      fs.writeFileSync(
        policyPath,
        JSON.stringify(DEFAULT_POLICY_CONTEXT, null, 2),
        "utf-8"
      );
      return;
    }

    try {
      const raw = fs.readFileSync(policyPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const merged = {
        ...DEFAULT_POLICY_CONTEXT,
        ...parsed,
        intimacy_policy: {
          ...DEFAULT_POLICY_CONTEXT.intimacy_policy,
          ...(typeof parsed.intimacy_policy === "object" && parsed.intimacy_policy
            ? (parsed.intimacy_policy as Record<string, unknown>)
            : {}),
        },
      };
      fs.writeFileSync(policyPath, JSON.stringify(merged, null, 2), "utf-8");
    } catch {
      fs.writeFileSync(
        policyPath,
        JSON.stringify(DEFAULT_POLICY_CONTEXT, null, 2),
        "utf-8"
      );
    }
  }

  buildServiceSystemPrompt(personaName?: string, provider?: "claude" | "codex", options?: Record<string, unknown>): string {
    const files = provider === "codex" ? SERVICE_SESSION_GUIDE_FILES_CODEX : SERVICE_SESSION_GUIDE_FILES_CLAUDE;
    return this.buildPromptFromGuideFiles(files, personaName, options);
  }

  buildBuilderSystemPrompt(personaName?: string, options?: Record<string, unknown>): string {
    return this.buildPromptFromGuideFiles(BUILDER_GUIDE_FILES, personaName, options);
  }

  private buildPromptFromGuideFiles(files: readonly string[], personaName?: string, options?: Record<string, unknown>): string {
    const sections: string[] = [];
    for (const filename of files) {
      const guidePath = path.join(this.appRoot, filename);
      if (!fs.existsSync(guidePath)) continue;
      const content = this.readGuideContent(guidePath, personaName, options);
      if (content) sections.push(content);
    }
    return sections.join("\n\n").trim();
  }

  private readGuideContent(guidePath: string, personaName?: string, options?: Record<string, unknown>): string {
    const raw = fs.readFileSync(guidePath, "utf-8");
    const ext = path.extname(guidePath).toLowerCase();
    let base = ext === ".yaml" || ext === ".yml"
      ? this.extractActiveSystemPrompt(raw) || raw
      : raw;
    const actorName = personaName || "the current persona";
    base = base.replace(/\{agent_name\}/g, actorName).trim();

    // Compile Handlebars for .md files when options are provided
    if (options && ext === ".md") {
      try {
        const template = Handlebars.compile(base, { noEscape: true });
        base = template({ options }, { allowProtoPropertiesByDefault: true });
      } catch { /* fall through with uncompiled content */ }
    }

    return base;
  }

  private extractActiveSystemPrompt(yamlText: string): string | null {
    const lines = yamlText.split(/\r?\n/);
    const activeLine = lines.find((line) => /^active_system_prompt:\s*/.test(line));
    if (!activeLine) return null;

    const activeMatch = activeLine.match(
      /^active_system_prompt:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*$/
    );
    const activeKey = activeMatch?.[1] || activeMatch?.[2] || activeMatch?.[3];
    if (!activeKey) return null;

    const blockHeader = new RegExp(`^${this.escapeRegExp(activeKey)}:\\s*\\|\\s*$`);
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

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ── Helpers ──────────────────────────────────────────────

  private copyDirRecursive(src: string, dest: string, skip?: Set<string>): void {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (skip && skip.has(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        this.copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
