import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";

const execFileAsync = promisify(execFile);

type Params = { params: Promise<{ name: string }> };

/** Run git command in persona directory */
async function git(personaDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: personaDir,
    env: { ...process.env, GIT_AUTHOR_NAME: "Claude Bridge", GIT_AUTHOR_EMAIL: "bridge@local", GIT_COMMITTER_NAME: "Claude Bridge", GIT_COMMITTER_EMAIL: "bridge@local" },
    windowsHide: true,
  });
  return stdout.trim();
}

/** Ensure persona dir has a git repo */
async function ensureGitRepo(personaDir: string): Promise<void> {
  try {
    await fs.access(path.join(personaDir, ".git"));
  } catch {
    await git(personaDir, ["init"]);
    // Initial commit so we have a baseline
    await git(personaDir, ["add", "-A"]);
    try {
      await git(personaDir, ["commit", "-m", "Initial version"]);
    } catch {
      // Nothing to commit (empty dir) — that's fine
    }
  }
}

/** GET: List version history */
export async function GET(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const { sessions } = getServices();

  if (!sessions.personaExists(decoded)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const personaDir = sessions.getPersonaDir(decoded);
  await ensureGitRepo(personaDir);

  try {
    const log = await git(personaDir, [
      "log",
      "--pretty=format:%H|%ai|%s",
      "-50",
    ]);
    if (!log) {
      return NextResponse.json({ versions: [] });
    }
    const versions = log.split("\n").map((line) => {
      const [hash, date, ...msgParts] = line.split("|");
      return { hash, date, message: msgParts.join("|") };
    });
    return NextResponse.json({ versions });
  } catch {
    return NextResponse.json({ versions: [] });
  }
}

/** POST: Create a new version (snapshot) */
export async function POST(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const { sessions } = getServices();

  if (!sessions.personaExists(decoded)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const personaDir = sessions.getPersonaDir(decoded);
  await ensureGitRepo(personaDir);

  const body = await req.json().catch(() => ({}));
  const message = (body as Record<string, string>).message || `Snapshot ${new Date().toLocaleString("ko-KR")}`;

  // Stage all changes
  await git(personaDir, ["add", "-A"]);

  // Check if there are staged changes
  try {
    const status = await git(personaDir, ["status", "--porcelain"]);
    if (!status) {
      return NextResponse.json({ ok: false, error: "No changes to save" }, { status: 400 });
    }
  } catch {
    // ignore
  }

  try {
    await git(personaDir, ["commit", "-m", message]);
    const hash = await git(personaDir, ["rev-parse", "HEAD"]);
    return NextResponse.json({ ok: true, hash });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

/** PUT: Restore to a specific version */
export async function PUT(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const { sessions } = getServices();

  if (!sessions.personaExists(decoded)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const personaDir = sessions.getPersonaDir(decoded);
  await ensureGitRepo(personaDir);

  const body = await req.json();
  const hash = (body as Record<string, string>).hash;

  if (!hash || !/^[a-f0-9]{7,40}$/.test(hash)) {
    return NextResponse.json({ error: "Invalid hash" }, { status: 400 });
  }

  try {
    // Save current state first (auto-commit if dirty)
    await git(personaDir, ["add", "-A"]);
    try {
      await git(personaDir, ["commit", "-m", `Auto-save before restore to ${hash.slice(0, 7)}`]);
    } catch {
      // Nothing to commit — that's fine
    }

    // Restore: checkout the target version's files, then commit as a new "restore" commit
    await git(personaDir, ["checkout", hash, "--", "."]);
    await git(personaDir, ["add", "-A"]);
    await git(personaDir, ["commit", "-m", `Restored to ${hash.slice(0, 7)}`]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
