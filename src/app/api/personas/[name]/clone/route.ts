import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(process.cwd(), "data", "personas");

// Files/dirs to exclude when cloning a persona
const EXCLUDE = new Set([
  ".git",
  ".claude",
  ".codex",
  ".gemini",
  ".mcp.json",
  "builder-session.json",
  "chat-history.json",
  "claude-stream.log",
  "import-meta.json",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
]);

function copyRecursive(src: string, dest: string) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    if (EXCLUDE.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** POST: clone persona to new folder name */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { folderName } = (await req.json()) as { folderName?: string };

  if (!folderName || !folderName.trim()) {
    return NextResponse.json({ error: "폴더명을 입력해주세요." }, { status: 400 });
  }

  const trimmed = folderName.trim();

  // Validate folder name (no path traversal, no special chars)
  if (/[<>:"/\\|?*]/.test(trimmed) || trimmed.includes("..")) {
    return NextResponse.json({ error: "사용할 수 없는 폴더명입니다." }, { status: 400 });
  }

  const srcDir = path.join(DATA_DIR, decodeURIComponent(name));
  if (!fs.existsSync(srcDir)) {
    return NextResponse.json({ error: "원본 페르소나를 찾을 수 없습니다." }, { status: 404 });
  }

  const destDir = path.join(DATA_DIR, trimmed);
  if (fs.existsSync(destDir)) {
    return NextResponse.json({ error: "이미 존재하는 폴더명입니다." }, { status: 409 });
  }

  try {
    copyRecursive(srcDir, destDir);
    return NextResponse.json({ ok: true, name: trimmed });
  } catch (err) {
    // Cleanup on failure
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    return NextResponse.json(
      { error: `복제 실패: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

/** GET: check if folder name is available */
export async function GET(req: NextRequest) {
  const folderName = req.nextUrl.searchParams.get("folderName");
  if (!folderName) {
    return NextResponse.json({ available: false, error: "폴더명 필요" });
  }
  const exists = fs.existsSync(path.join(DATA_DIR, folderName));
  return NextResponse.json({ available: !exists });
}
