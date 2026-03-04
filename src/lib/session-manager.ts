import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";

export interface PersonaInfo {
  name: string; // directory name
  displayName: string; // from persona.md first line or name
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
  title: string;
  createdAt: string;
  hasIcon?: boolean;
}

export interface PersonaOverview {
  files: Array<{ name: string; exists: boolean; preview: string | null }>;
  panels: string[];
  panelData: Array<{ name: string; html: string }>;
  skills: string[];
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
  profileSlug?: string;
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
      "Bash(curl *)",
      "Bash(bash ./*.sh *)",
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
    fs.mkdirSync(path.join(this.dataDir, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, "tools"), { recursive: true });
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

          // Load variables.json for Handlebars rendering
          let variables: Record<string, unknown> = {};
          const varsPath = path.join(dir, "variables.json");
          if (fs.existsSync(varsPath)) {
            try {
              variables = JSON.parse(fs.readFileSync(varsPath, "utf-8"));
            } catch { /* ignore */ }
          }

          // Render each panel
          panelData = panelFiles.map((file) => {
            const rawName = file.replace(/\.html$/, "");
            const name = rawName.replace(/^\d+-/, "");
            try {
              const source = fs.readFileSync(path.join(panelsDir, file), "utf-8");
              const template = Handlebars.compile(source);
              const html = template(variables, { allowProtoPropertiesByDefault: true });
              return { name, html };
            } catch {
              return { name, html: `<div style="color:#ff4d6a;padding:8px;">Panel "${name}" render error</div>` };
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

      // Check for profile/icon images
      const imagesDir = path.join(dir, "images");
      const hasProfile = fs.existsSync(path.join(imagesDir, "profile.png"));
      const hasIcon = fs.existsSync(path.join(imagesDir, "icon.png"));

      return {
        files, panels, panelData, skills,
        ...(hasProfile ? { hasProfile: true } : {}),
        ...(hasIcon ? { hasIcon: true } : {}),
      };
    } catch {
      return { files: [], panels: [], panelData: [], skills: [] };
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

    // Copy session-instructions.md as CLAUDE.md for the session
    const sessionInstructionsSrc = path.join(personaDir, "session-instructions.md");
    const sessionClaudeMd = path.join(sessionDir, "CLAUDE.md");
    if (fs.existsSync(sessionInstructionsSrc)) {
      fs.copyFileSync(sessionInstructionsSrc, sessionClaudeMd);
    }

    // Write session metadata
    const meta: SessionMeta = {
      persona: personaName,
      title: title || personaName,
      createdAt: new Date().toISOString(),
      ...(profile ? { profileSlug: this.profileSlug(profile.name) } : {}),
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

    // If profile is provided, inject user info into CLAUDE.md
    if (profile) {
      const claudeMdPath = path.join(sessionDir, "CLAUDE.md");
      if (fs.existsSync(claudeMdPath)) {
        const existing = fs.readFileSync(claudeMdPath, "utf-8");
        const userSection = `\n\n## 사용자 정보\n사용자의 이름: ${profile.name}\n${profile.description}\n`;
        fs.writeFileSync(claudeMdPath, existing + userSection, "utf-8");
      }
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
    const skillsDest = path.join(claudeDir, "skills");
    fs.mkdirSync(skillsDest, { recursive: true });
    if (fs.existsSync(personaSkillsSrc)) {
      this.copyDirRecursive(personaSkillsSrc, skillsDest);
    }

    // Copy global tool skills (data/tools/*/skills/*) to session
    this.copyToolSkills(skillsDest);

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
          const iconPath = path.join(dir, d.name, "images", "icon.png");
          const hasIcon = fs.existsSync(iconPath);
          return { id: d.name, ...meta, ...(hasIcon ? { hasIcon: true } : {}) };
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

  /** Regenerate CLAUDE.md from persona's latest session-instructions.md */
  refreshSessionClaudeMd(id: string): void {
    const sessionDir = this.getSessionDir(id);
    const metaPath = path.join(sessionDir, "session.json");
    if (!fs.existsSync(metaPath)) return;

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch { return; }

    const personaDir = this.getPersonaDir(meta.persona);
    if (!fs.existsSync(personaDir)) return;

    // 1. Copy latest session-instructions.md as CLAUDE.md
    const instructionsSrc = path.join(personaDir, "session-instructions.md");
    const claudeMdPath = path.join(sessionDir, "CLAUDE.md");
    if (fs.existsSync(instructionsSrc)) {
      fs.copyFileSync(instructionsSrc, claudeMdPath);
    } else {
      return; // No instructions, nothing to do
    }

    // 2. Re-inject profile info if session had one
    if (meta.profileSlug) {
      const profile = this.getProfile(meta.profileSlug);
      if (profile) {
        const existing = fs.readFileSync(claudeMdPath, "utf-8");
        const userSection = `\n\n## 사용자 정보\n사용자의 이름: ${profile.name}\n${profile.description}\n`;
        fs.writeFileSync(claudeMdPath, existing + userSection, "utf-8");
      }
    }

    // 3. Re-append opening context
    const openingPath = path.join(sessionDir, "opening.md");
    if (fs.existsSync(openingPath)) {
      const openingContent = fs.readFileSync(openingPath, "utf-8").trim();
      if (openingContent) {
        const existing = fs.readFileSync(claudeMdPath, "utf-8");
        const appendix = `\n\n## 오프닝 메시지\n아래 메시지는 세션 시작 시 사용자에게 이미 표시되었다. 이 메시지를 반복하지 마라.\n\n${openingContent}\n`;
        fs.writeFileSync(claudeMdPath, existing + appendix, "utf-8");
      }
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

  // ── Tools ──────────────────────────────────────────────

  /** Copy skills from all global tools (data/tools/X/skills/) into the session skills dir */
  private copyToolSkills(skillsDest: string): void {
    const toolsDir = path.join(this.dataDir, "tools");
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

  // ── Helpers ──────────────────────────────────────────────

  private copyDirRecursive(src: string, dest: string, skip?: Set<string>): void {
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
