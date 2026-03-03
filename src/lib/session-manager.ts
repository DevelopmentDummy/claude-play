import * as fs from "fs";
import * as path from "path";

export interface PersonaInfo {
  name: string; // directory name
  displayName: string; // from persona.md first line or name
}

export interface SessionInfo {
  id: string; // directory name
  persona: string;
  title: string;
  createdAt: string;
}

export interface PersonaOverview {
  files: Array<{ name: string; exists: boolean; preview: string | null }>;
  panels: string[];
  skills: string[];
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
  panels: { position: "right", size: 280 },
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
}

interface BuilderMeta {
  claudeSessionId?: string;
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
      "Glob",
      "Grep",
    ],
  },
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
        return { name: d.name, displayName };
      });
  }

  getPersonaDir(name: string): string {
    return path.join(this.personasDir(), name);
  }

  personaExists(name: string): boolean {
    return fs.existsSync(this.getPersonaDir(name));
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
        "CLAUDE.md",
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
      const panelsDir = path.join(dir, "panels");
      if (fs.existsSync(panelsDir)) {
        try {
          panels = fs
            .readdirSync(panelsDir)
            .filter((f) => f.endsWith(".html"));
        } catch {
          panels = [];
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

      return { files, panels, skills };
    } catch {
      return { files: [], panels: [], skills: [] };
    }
  }

  // ── Session ──────────────────────────────────────────────

  createSession(personaName: string, title?: string): SessionInfo {
    if (!this.personaExists(personaName)) {
      throw new Error(`Persona "${personaName}" not found`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const id = `${personaName}-${timestamp}`;
    const sessionDir = path.join(this.sessionsDir(), id);

    // Create session directory
    fs.mkdirSync(sessionDir, { recursive: true });

    // Copy persona files to session
    const personaDir = this.getPersonaDir(personaName);
    this.copyDirRecursive(personaDir, sessionDir);

    // Write session metadata
    const meta: SessionMeta = {
      persona: personaName,
      title: title || personaName,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(sessionDir, "session.json"),
      JSON.stringify(meta, null, 2),
      "utf-8"
    );

    // Create .claude/settings.json for permission sandboxing
    const claudeDir = path.join(sessionDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(CLAUDE_SETTINGS, null, 2),
      "utf-8"
    );

    // Ensure memory.md exists
    const memoryPath = path.join(sessionDir, "memory.md");
    if (!fs.existsSync(memoryPath)) {
      fs.writeFileSync(memoryPath, "", "utf-8");
    }

    // If opening.md exists, append opening context to CLAUDE.md
    const openingPath = path.join(sessionDir, "opening.md");
    if (fs.existsSync(openingPath)) {
      const openingContent = fs.readFileSync(openingPath, "utf-8").trim();
      if (openingContent) {
        const claudeMdPath = path.join(sessionDir, "CLAUDE.md");
        const existing = fs.existsSync(claudeMdPath)
          ? fs.readFileSync(claudeMdPath, "utf-8")
          : "";
        const appendix = `\n\n## 오프닝 메시지\n아래 메시지는 세션 시작 시 사용자에게 이미 표시되었다. 이 메시지를 반복하지 마라.\n\n${openingContent}\n`;
        fs.writeFileSync(claudeMdPath, existing + appendix, "utf-8");
      }
    }

    // Copy panel-spec.md from appRoot to sessionDir
    const panelSpecSrc = path.join(this.appRoot, "panel-spec.md");
    if (fs.existsSync(panelSpecSrc)) {
      fs.copyFileSync(panelSpecSrc, path.join(sessionDir, "panel-spec.md"));
    }

    // Copy persona skills/ to sessionDir/.claude/skills/
    const personaSkillsSrc = path.join(personaDir, "skills");
    if (fs.existsSync(personaSkillsSrc)) {
      const skillsDest = path.join(claudeDir, "skills");
      fs.mkdirSync(skillsDest, { recursive: true });
      this.copyDirRecursive(personaSkillsSrc, skillsDest);
    }

    return { id, ...meta };
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
          return { id: d.name, ...meta };
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

  getSessionInfo(id: string): SessionInfo | null {
    const metaPath = path.join(this.getSessionDir(id), "session.json");
    if (!fs.existsSync(metaPath)) return null;
    try {
      const meta: SessionMeta = JSON.parse(
        fs.readFileSync(metaPath, "utf-8")
      );
      return { id, ...meta };
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

  deleteSession(id: string): void {
    const dir = this.getSessionDir(id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

    // Place .claude/settings.json so the builder Claude can write freely
    const claudeDir = path.join(dir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(CLAUDE_SETTINGS, null, 2),
      "utf-8"
    );

    return dir;
  }

  /** Read the builder meta-prompt from the static file bundled with the app */
  getBuilderPrompt(): string {
    const promptPath = path.join(this.appRoot, "builder-prompt.md");
    return fs.readFileSync(promptPath, "utf-8");
  }

  /** Save builder Claude session ID for resume */
  saveBuilderSessionId(name: string, claudeSessionId: string): void {
    const metaPath = path.join(this.getPersonaDir(name), "builder-session.json");
    const meta: BuilderMeta = { claudeSessionId };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  /** Get saved builder session ID for resume */
  getBuilderSessionId(name: string): string | undefined {
    const metaPath = path.join(this.getPersonaDir(name), "builder-session.json");
    if (!fs.existsSync(metaPath)) return undefined;
    try {
      const meta: BuilderMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      return meta.claudeSessionId;
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

  // ── Helpers ──────────────────────────────────────────────

  private copyDirRecursive(src: string, dest: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
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
