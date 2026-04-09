import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";

const execFileAsync = promisify(execFile);

type Params = { params: Promise<{ name: string }> };

const GITIGNORE_ENTRIES = [
  "chat-history.json",
  "memory.md",
  "builder-session.json",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".claude/",
  ".agents/",
  ".gemini/",
  ".codex/",
];

/** Run git command in persona directory */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Claude Play",
      GIT_AUTHOR_EMAIL: "bridge@local",
      GIT_COMMITTER_NAME: "Claude Play",
      GIT_COMMITTER_EMAIL: "bridge@local",
    },
    windowsHide: true,
    timeout: 30_000,
  });
  return stdout.trim();
}

/** Ensure persona dir has a git repo */
async function ensureGitRepo(personaDir: string): Promise<void> {
  try {
    await fs.access(path.join(personaDir, ".git"));
  } catch {
    await git(personaDir, ["init"]);
  }
}

/** Ensure .gitignore contains all required entries */
async function ensureGitignore(personaDir: string): Promise<void> {
  const gitignorePath = path.join(personaDir, ".gitignore");
  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  const lines = content.split("\n").map((l) => l.trim());
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length > 0) {
    const suffix = (content && !content.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n";
    await fs.writeFile(gitignorePath, content + suffix, "utf-8");
  }
}

/** Ensure persona.json exists */
async function ensurePersonaJson(personaDir: string, displayName: string): Promise<void> {
  const jsonPath = path.join(personaDir, "persona.json");
  try {
    await fs.access(jsonPath);
  } catch {
    await fs.writeFile(
      jsonPath,
      JSON.stringify(
        { name: displayName, version: "1.0.0", publishedAt: new Date().toISOString() },
        null,
        2
      ),
      "utf-8"
    );
  }
}

/** POST: Publish persona to a remote git repo */
export async function POST(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const { sessions } = getServices();

  if (!sessions.personaExists(decoded)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const url = (body as Record<string, string>).url;
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const ALLOWED_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;
  if (!ALLOWED_URL_RE.test(url)) {
    return NextResponse.json({ error: "Only GitHub HTTPS URLs are supported" }, { status: 400 });
  }

  const personaDir = sessions.getPersonaDir(decoded);
  const displayName = sessions.getPersonaDisplayName(decoded);

  try {
    // 1. Ensure git repo
    await ensureGitRepo(personaDir);

    // 2. Ensure .gitignore
    await ensureGitignore(personaDir);

    // 3. Ensure persona.json
    await ensurePersonaJson(personaDir, displayName);

    // 4. Stage and commit
    await git(personaDir, ["add", "-A"]);
    try {
      await git(personaDir, ["commit", "-m", "Prepare for publish"]);
    } catch (err: unknown) {
      const msg = String(err);
      if (!msg.includes("nothing to commit") && !msg.includes("nothing added")) throw err;
    }

    // 5. Set remote origin
    try {
      await git(personaDir, ["remote", "remove", "origin"]);
    } catch {
      // no existing origin — that's fine
    }
    await git(personaDir, ["remote", "add", "origin", url]);

    // 6. Push
    const branch = await git(personaDir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "main");
    await git(personaDir, ["push", "-u", "origin", branch]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
