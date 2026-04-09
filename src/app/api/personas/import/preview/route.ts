import { NextRequest, NextResponse } from "next/server";

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // Support https://github.com/owner/repo and https://github.com/owner/repo.git
  const match = url.match(
    /(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function randomChars(n: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < n; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function fetchRaw(
  owner: string,
  repo: string,
  branch: string,
  path: string
): Promise<Response> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  return fetch(url, { signal: AbortSignal.timeout(10_000) });
}

async function tryFetchFile(
  owner: string,
  repo: string,
  path: string
): Promise<{ body: string; branch: string } | null> {
  for (const branch of ["master", "main"]) {
    const res = await fetchRaw(owner, repo, branch, path);
    if (res.ok) {
      return { body: await res.text(), branch };
    }
  }
  return null;
}

async function tryFetchBinary(
  owner: string,
  repo: string,
  branch: string,
  path: string
): Promise<{ buffer: Buffer; mime: string } | null> {
  const res = await fetchRaw(owner, repo, branch, path);
  if (!res.ok) return null;
  const contentLength = res.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > 512_000) return null;
  const mime = res.headers.get("content-type") || "image/png";
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mime };
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    const parsed = parseGitHubUrl(url.trim());
    if (!parsed) {
      return NextResponse.json(
        { error: "유효한 GitHub URL이 아닙니다" },
        { status: 400 }
      );
    }

    const { owner, repo } = parsed;

    // Try persona.json first
    let displayName = "";
    let description = "";
    let tags: string[] = [];
    let version = "";
    let author = "";
    let branch = "main";

    const jsonResult = await tryFetchFile(owner, repo, "persona.json");
    if (jsonResult) {
      branch = jsonResult.branch;
      try {
        const meta = JSON.parse(jsonResult.body);
        displayName = meta.displayName || meta.name || "";
        description = meta.description || "";
        tags = Array.isArray(meta.tags) ? meta.tags : [];
        version = meta.version || "";
        author = meta.author || "";
      } catch {
        // Invalid JSON — treat as missing
      }
    }

    if (!displayName) {
      // Try persona.md
      const mdResult = await tryFetchFile(owner, repo, "persona.md");
      if (mdResult) {
        // Only use the branch from persona.md if persona.json didn't already set it
        if (!jsonResult) branch = mdResult.branch;
        const firstLine = mdResult.body.split("\n")[0]?.trim() || "";
        displayName = firstLine.replace(/^#\s*/, "");
      }
    }

    if (!displayName) {
      return NextResponse.json(
        { error: "유효한 페르소나 리포가 아닙니다" },
        { status: 400 }
      );
    }

    // Fetch icon
    let icon: string | null = null;
    const iconResult = await tryFetchBinary(
      owner,
      repo,
      branch,
      "images/icon.png"
    );
    if (iconResult) {
      icon = `data:${iconResult.mime};base64,${iconResult.buffer.toString("base64")}`;
    }

    const defaultFolderName = `${repo}-${randomChars(4)}`;

    return NextResponse.json({
      owner,
      repo,
      branch,
      displayName,
      description,
      tags,
      version,
      author,
      icon,
      defaultFolderName,
    });
  } catch (err) {
    console.error("[import/preview] error:", err);
    return NextResponse.json(
      { error: "Failed to fetch persona preview" },
      { status: 500 }
    );
  }
}
