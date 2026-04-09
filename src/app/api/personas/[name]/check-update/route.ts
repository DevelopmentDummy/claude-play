import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

type Params = { params: Promise<{ name: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);
  const { sessions } = getServices();

  if (!sessions.personaExists(decodedName)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const personaDir = sessions.getPersonaDir(decodedName);
  const metaPath = path.join(personaDir, "import-meta.json");

  if (!fs.existsSync(metaPath)) {
    return NextResponse.json(
      { error: "Not an imported persona" },
      { status: 400 }
    );
  }

  // Verify the persona directory is a git repo before running any git commands
  const gitDir = path.join(personaDir, ".git");
  if (!fs.existsSync(gitDir)) {
    return NextResponse.json(
      { error: "Persona directory is not a git repository (.git not found)" },
      { status: 400 }
    );
  }

  const gitOpts = { cwd: personaDir, timeout: 30_000, windowsHide: true };

  try {
    // Fetch latest from remote
    await execFileAsync("git", ["fetch", "origin"], gitOpts);

    // Get local HEAD
    const { stdout: localRaw } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      gitOpts
    );
    const localHead = localRaw.trim();

    // Get remote HEAD: try origin/master, fallback to origin/main
    let remoteHead: string;
    try {
      const { stdout: r } = await execFileAsync(
        "git",
        ["rev-parse", "origin/master"],
        gitOpts
      );
      remoteHead = r.trim();
    } catch {
      const { stdout: r } = await execFileAsync(
        "git",
        ["rev-parse", "origin/main"],
        gitOpts
      );
      remoteHead = r.trim();
    }

    // Validate remoteHead is a well-formed SHA-1
    if (!/^[a-f0-9]{40}$/.test(remoteHead)) {
      return NextResponse.json(
        { error: `Invalid remote HEAD SHA: ${remoteHead}` },
        { status: 500 }
      );
    }

    if (localHead === remoteHead) {
      return NextResponse.json({
        upToDate: true,
        localHead,
        remoteHead,
        behindCount: 0,
      });
    }

    // Count commits behind
    const { stdout: countRaw } = await execFileAsync(
      "git",
      ["rev-list", "--count", `HEAD..${remoteHead}`],
      gitOpts
    );
    const behindCount = parseInt(countRaw.trim(), 10);

    if (isNaN(behindCount)) {
      return NextResponse.json(
        { error: "Failed to parse commit count from git rev-list output" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      upToDate: false,
      localHead,
      remoteHead,
      behindCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
