import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

export async function POST(req: Request) {
  const { url, folderName } = await req.json();

  if (!url || !folderName) {
    return NextResponse.json(
      { error: "url and folderName are required" },
      { status: 400 }
    );
  }

  // Reject path traversal
  if (/[/\\]|\.\./.test(folderName)) {
    return NextResponse.json(
      { error: "Invalid folderName: path traversal not allowed" },
      { status: 400 }
    );
  }

  const { sessions } = getServices();

  if (sessions.personaExists(folderName)) {
    return NextResponse.json(
      { error: `Persona "${folderName}" already exists` },
      { status: 409 }
    );
  }

  const personaDir = sessions.getPersonaDir(folderName);

  try {
    // Clone the repository
    await execFileAsync("git", ["clone", url, personaDir], {
      timeout: 60_000,
      windowsHide: true,
    });

    // Get HEAD commit hash
    const { stdout: commitHash } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: personaDir, windowsHide: true }
    );

    // Write import metadata
    const importMeta = {
      source: "github",
      url,
      installedAt: new Date().toISOString(),
      installedCommit: commitHash.trim(),
    };
    fs.writeFileSync(
      path.join(personaDir, "import-meta.json"),
      JSON.stringify(importMeta, null, 2)
    );

    // Set up builder runtime configs
    sessions.ensureClaudeRuntimeConfig(personaDir, folderName, "builder");

    return NextResponse.json({ ok: true, name: folderName });
  } catch (err: unknown) {
    // Cleanup partially cloned directory on failure
    if (fs.existsSync(personaDir)) {
      fs.rmSync(personaDir, { recursive: true, force: true });
    }

    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Import failed: ${message}` },
      { status: 500 }
    );
  }
}
