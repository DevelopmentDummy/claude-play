# Persona Sharing System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub를 백엔드로 활용하여 페르소나를 publish/import/update할 수 있는 공유 시스템 구현

**Architecture:** 기존 페르소나 내부 git을 그대로 활용. Import는 git clone, Publish는 remote add + push. 미리보기는 GitHub Raw API로 메타데이터 fetch. 보안 점검과 빌더 세션 자동 메시지 주입은 기존 빌더 인프라 활용.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind CSS 3, TypeScript, git CLI (`child_process.execFile`)

**Spec:** `docs/superpowers/specs/2026-04-10-persona-sharing-design.md`

---

## File Structure

### New Files
- `src/app/api/personas/import/preview/route.ts` — Import 미리보기 API (GitHub Raw fetch)
- `src/app/api/personas/import/route.ts` — Import 설치 API (git clone)
- `src/app/api/personas/[name]/publish/route.ts` — Publish API (remote add + push)
- `src/app/api/personas/[name]/check-update/route.ts` — 업데이트 체크 API
- `src/components/ImportPersonaModal.tsx` — Import 미리보기 + 설치 모달
- `src/components/PublishPersonaModal.tsx` — Publish 모달 (URL 입력 or 빌더 세션)

### Modified Files
- `src/lib/session-manager.ts` — `PersonaInfo`에 import 메타 추가, 리스트에 반영
- `src/app/page.tsx` — 로비에 Import 버튼, 업데이트 체크 버튼 추가
- `src/components/PersonaCard.tsx` — import된 페르소나 표시, 업데이트 체크 버튼
- `src/app/builder/[name]/page.tsx` — `initialMessage` 쿼리 파라미터로 자동 메시지 주입

---

## Task 1: Import Preview API

GitHub Raw API로 페르소나 메타데이터와 아이콘을 fetch하는 엔드포인트.

**Files:**
- Create: `src/app/api/personas/import/preview/route.ts`

- [ ] **Step 1: Create the preview API route**

이 API는 GitHub URL을 받아 `persona.json`, `persona.md`, `icon.png`를 fetch하고 미리보기 데이터를 반환한다.

```typescript
// src/app/api/personas/import/preview/route.ts
import { NextRequest, NextResponse } from "next/server";

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // https://github.com/owner/repo or https://github.com/owner/repo.git
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function rawUrl(owner: string, repo: string, branch: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const url = (body as Record<string, string>)?.url;

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid GitHub URL" }, { status: 400 });
  }

  const { owner, repo } = parsed;
  const branch = "master"; // try master first, fallback to main

  // Try to fetch persona.json and persona.md in parallel
  let personaJson: Record<string, unknown> | null = null;
  let personaMdFirstLine: string | null = null;
  let iconBase64: string | null = null;
  let detectedBranch = branch;

  // Try master first, then main
  for (const b of ["master", "main"]) {
    const personaJsonRes = await fetch(rawUrl(owner, repo, b, "persona.json"));
    if (personaJsonRes.ok) {
      personaJson = await personaJsonRes.json();
      detectedBranch = b;
      break;
    }
    const personaMdRes = await fetch(rawUrl(owner, repo, b, "persona.md"));
    if (personaMdRes.ok) {
      const text = await personaMdRes.text();
      personaMdFirstLine = text.split("\n")[0].replace(/^#\s*/, "").trim();
      detectedBranch = b;
      break;
    }
  }

  // Validation: must have at least persona.md
  if (!personaJson && !personaMdFirstLine) {
    return NextResponse.json(
      { error: "유효한 페르소나 리포가 아닙니다. persona.json 또는 persona.md가 필요합니다." },
      { status: 400 }
    );
  }

  // Try to fetch icon
  const iconRes = await fetch(rawUrl(owner, repo, detectedBranch, "images/icon.png"));
  if (iconRes.ok) {
    const buf = Buffer.from(await iconRes.arrayBuffer());
    iconBase64 = `data:image/png;base64,${buf.toString("base64")}`;
  }

  // Generate default folder name with random hash
  const hash = Math.random().toString(36).substring(2, 6);
  const defaultFolderName = `${repo}-${hash}`;

  return NextResponse.json({
    owner,
    repo,
    branch: detectedBranch,
    displayName: personaJson?.displayName || personaMdFirstLine || repo,
    description: personaJson?.description || null,
    tags: personaJson?.tags || [],
    version: personaJson?.version || null,
    author: personaJson?.author || owner,
    icon: iconBase64,
    defaultFolderName,
  });
}
```

- [ ] **Step 2: Test manually with curl**

Run: `curl -X POST http://localhost:3340/api/personas/import/preview -H "Content-Type: application/json" -d '{"url":"https://github.com/some-user/some-persona-repo"}'`

Expected: JSON response with persona metadata or validation error.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/personas/import/preview/route.ts
git commit -m "feat: add persona import preview API"
```

---

## Task 2: Import (Clone) API

GitHub 리포를 clone하여 로컬에 설치하는 엔드포인트.

**Files:**
- Create: `src/app/api/personas/import/route.ts`

- [ ] **Step 1: Create the import API route**

```typescript
// src/app/api/personas/import/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { url, folderName } = (body as Record<string, string>) || {};

  if (!url || !folderName) {
    return NextResponse.json({ error: "Missing url or folderName" }, { status: 400 });
  }

  // Validate folderName — no path traversal
  if (/[/\\]|\.\./.test(folderName)) {
    return NextResponse.json({ error: "Invalid folder name" }, { status: 400 });
  }

  const { sessions } = getServices();
  const personaDir = sessions.getPersonaDir(folderName);

  if (fs.existsSync(personaDir)) {
    return NextResponse.json({ error: `"${folderName}" already exists` }, { status: 409 });
  }

  try {
    // git clone
    await execFileAsync("git", ["clone", url, personaDir], {
      windowsHide: true,
      timeout: 60000,
    });

    // Write import-meta.json
    const headHash = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: personaDir,
      windowsHide: true,
    });

    const importMeta = {
      source: "github",
      url,
      installedAt: new Date().toISOString(),
      installedCommit: headHash.stdout.trim(),
    };
    fs.writeFileSync(
      path.join(personaDir, "import-meta.json"),
      JSON.stringify(importMeta, null, 2),
      "utf-8"
    );

    // Ensure runtime configs exist for builder sessions
    sessions.ensureClaudeRuntimeConfig(personaDir, folderName, "builder");

    return NextResponse.json({ ok: true, name: folderName });
  } catch (err) {
    // Cleanup on failure
    if (fs.existsSync(personaDir)) {
      fs.rmSync(personaDir, { recursive: true, force: true });
    }
    return NextResponse.json({ error: `Clone failed: ${String(err)}` }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify ensureClaudeRuntimeConfig is accessible**

`ensureClaudeRuntimeConfig` is called from `createPersonaDir` already. Check it exists as a public method on `SessionManager`. If it's private, make it public or extract the logic.

Run: `grep -n "ensureClaudeRuntimeConfig" src/lib/session-manager.ts`

If private, change visibility to public.

- [ ] **Step 3: Test manually**

Run: `curl -X POST http://localhost:3340/api/personas/import -H "Content-Type: application/json" -d '{"url":"https://github.com/some-user/some-persona-repo","folderName":"test-import-abc1"}'`

Expected: `{ "ok": true, "name": "test-import-abc1" }` and persona directory created.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/personas/import/route.ts
git commit -m "feat: add persona import (git clone) API"
```

---

## Task 3: Publish API

기존 페르소나 git에 remote 추가 + push.

**Files:**
- Create: `src/app/api/personas/[name]/publish/route.ts`

- [ ] **Step 1: Create the publish API route**

```typescript
// src/app/api/personas/[name]/publish/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

type Params = { params: Promise<{ name: string }> };

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Claude Play",
  GIT_AUTHOR_EMAIL: "bridge@local",
  GIT_COMMITTER_NAME: "Claude Play",
  GIT_COMMITTER_EMAIL: "bridge@local",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    windowsHide: true,
  });
  return stdout.trim();
}

export async function POST(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const { sessions } = getServices();

  if (!sessions.personaExists(decoded)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const { url } = (body as Record<string, string>) || {};

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const personaDir = sessions.getPersonaDir(decoded);

  try {
    // Ensure git repo exists
    if (!fs.existsSync(path.join(personaDir, ".git"))) {
      await git(personaDir, ["init"]);
      await git(personaDir, ["add", "-A"]);
      await git(personaDir, ["commit", "-m", "Initial version"]);
    }

    // Ensure .gitignore excludes sensitive files
    const gitignorePath = path.join(personaDir, ".gitignore");
    const requiredIgnores = [
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
    let existingIgnore = "";
    if (fs.existsSync(gitignorePath)) {
      existingIgnore = fs.readFileSync(gitignorePath, "utf-8");
    }
    const missing = requiredIgnores.filter((i) => !existingIgnore.includes(i));
    if (missing.length > 0) {
      const addition = "\n# Excluded from publish\n" + missing.join("\n") + "\n";
      fs.appendFileSync(gitignorePath, addition, "utf-8");
    }

    // Ensure persona.json exists
    const personaJsonPath = path.join(personaDir, "persona.json");
    if (!fs.existsSync(personaJsonPath)) {
      const displayName = sessions.getPersonaDisplayName(decoded);
      const meta = {
        displayName,
        description: "",
        tags: [],
        version: "1.0.0",
        author: "",
      };
      fs.writeFileSync(personaJsonPath, JSON.stringify(meta, null, 2), "utf-8");
    }

    // Stage and commit any new files (.gitignore, persona.json)
    await git(personaDir, ["add", "-A"]);
    try {
      await git(personaDir, ["commit", "-m", "Prepare for publish"]);
    } catch {
      // Nothing new to commit — fine
    }

    // Set remote
    try {
      await git(personaDir, ["remote", "remove", "origin"]);
    } catch {
      // No existing remote — fine
    }
    await git(personaDir, ["remote", "add", "origin", url]);

    // Push
    await git(personaDir, ["push", "-u", "origin", "master"]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/personas/[name]/publish/route.ts
git commit -m "feat: add persona publish API (remote add + push)"
```

---

## Task 4: Update Check API

remote HEAD와 로컬 HEAD를 비교하여 업데이트 가능 여부 반환.

**Files:**
- Create: `src/app/api/personas/[name]/check-update/route.ts`

- [ ] **Step 1: Create the check-update API route**

```typescript
// src/app/api/personas/[name]/check-update/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

type Params = { params: Promise<{ name: string }> };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: process.env,
    windowsHide: true,
    timeout: 30000,
  });
  return stdout.trim();
}

export async function POST(_req: NextRequest, { params }: Params) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const { sessions } = getServices();

  if (!sessions.personaExists(decoded)) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  const personaDir = sessions.getPersonaDir(decoded);
  const importMetaPath = path.join(personaDir, "import-meta.json");

  if (!fs.existsSync(importMetaPath)) {
    return NextResponse.json({ error: "Not an imported persona" }, { status: 400 });
  }

  try {
    await git(personaDir, ["fetch", "origin"]);

    const localHead = await git(personaDir, ["rev-parse", "HEAD"]);
    // Get the remote tracking branch HEAD
    let remoteHead: string;
    try {
      remoteHead = await git(personaDir, ["rev-parse", "origin/master"]);
    } catch {
      remoteHead = await git(personaDir, ["rev-parse", "origin/main"]);
    }

    const isUpToDate = localHead === remoteHead;

    let behindCount = 0;
    if (!isUpToDate) {
      const countStr = await git(personaDir, [
        "rev-list",
        "--count",
        `HEAD..${remoteHead}`,
      ]);
      behindCount = parseInt(countStr, 10) || 0;
    }

    return NextResponse.json({
      upToDate: isUpToDate,
      localHead,
      remoteHead,
      behindCount,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/personas/[name]/check-update/route.ts
git commit -m "feat: add persona update check API"
```

---

## Task 5: PersonaInfo에 Import 메타 반영

`listPersonas()`가 import된 페르소나를 구분할 수 있도록 `PersonaInfo` 확장.

**Files:**
- Modify: `src/lib/session-manager.ts`

- [ ] **Step 1: Extend PersonaInfo interface**

`session-manager.ts`에서 `PersonaInfo` 인터페이스를 찾아 `importMeta` 필드를 추가한다.

기존:
```typescript
export interface PersonaInfo {
  name: string;
  displayName: string;
  hasIcon?: boolean;
}
```

변경:
```typescript
export interface PersonaInfo {
  name: string;
  displayName: string;
  hasIcon?: boolean;
  importMeta?: {
    source: string;
    url: string;
    installedAt: string;
    installedCommit: string;
  };
}
```

- [ ] **Step 2: Update listPersonas to include importMeta**

`listPersonas()` 메서드의 `.map()` 콜백 안에서 `import-meta.json` 존재 여부를 체크하고 읽는다.

기존 return 문:
```typescript
return { name: d.name, displayName, hasIcon };
```

변경:
```typescript
let importMeta: PersonaInfo["importMeta"];
const importMetaPath = path.join(dir, d.name, "import-meta.json");
if (fs.existsSync(importMetaPath)) {
  try {
    importMeta = JSON.parse(fs.readFileSync(importMetaPath, "utf-8"));
  } catch { /* ignore */ }
}
return { name: d.name, displayName, hasIcon, importMeta };
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/session-manager.ts
git commit -m "feat: extend PersonaInfo with importMeta for imported personas"
```

---

## Task 6: Import Persona Modal

GitHub URL 입력 → 미리보기 → 설치 폴더명 편집 → 설치 → 보안 점검 제안 모달.

**Files:**
- Create: `src/components/ImportPersonaModal.tsx`

- [ ] **Step 1: Create ImportPersonaModal component**

```tsx
// src/components/ImportPersonaModal.tsx
"use client";

import { useState, useCallback, useEffect } from "react";

interface ImportPreview {
  owner: string;
  repo: string;
  branch: string;
  displayName: string;
  description: string | null;
  tags: string[];
  version: string | null;
  author: string;
  icon: string | null;
  defaultFolderName: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (name: string) => void;
  onOpenBuilder: (name: string, initialMessage: string) => void;
}

export default function ImportPersonaModal({ open, onClose, onImported, onOpenBuilder }: Props) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [folderName, setFolderName] = useState("");
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState(false);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!open) {
      setUrl("");
      setPreview(null);
      setFolderName("");
      setError("");
      setInstalled(false);
    }
  }, [open]);

  const handlePreview = useCallback(async () => {
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const res = await fetch("/api/personas/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Preview failed");
        return;
      }
      setPreview(data);
      setFolderName(data.defaultFolderName);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [url]);

  const handleInstall = useCallback(async () => {
    if (!folderName.trim()) return;
    setInstalling(true);
    setError("");
    try {
      const res = await fetch("/api/personas/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, folderName: folderName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Install failed");
        return;
      }
      setInstalled(true);
      onImported(data.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }, [url, folderName, onImported]);

  const handleSecurityReview = useCallback(() => {
    onOpenBuilder(
      folderName,
      "이 페르소나는 외부에서 가져온 것입니다. 보안 점검을 진행해주세요. tools/*.js, hooks/on-message.js, panels/*.html의 위험 패턴과 session-instructions.md의 prompt injection 여부를 확인해주세요."
    );
    onClose();
  }, [folderName, onOpenBuilder, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[12px] z-[100] flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-2xl w-full max-w-lg p-6 space-y-4 animate-[slideUp_0.25s_ease-out]">
        <h2 className="text-lg font-semibold text-text">Import Persona</h2>

        {!installed ? (
          <>
            {/* URL Input */}
            <div className="space-y-2">
              <label className="text-sm text-text-dim">GitHub URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handlePreview()}
                  placeholder="https://github.com/user/persona-repo"
                  className="flex-1 px-4 py-2.5 border border-border rounded-xl bg-[rgba(15,15,26,0.6)] text-text outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
                  disabled={loading || installing}
                />
                <button
                  onClick={handlePreview}
                  disabled={!url.trim() || loading}
                  className="px-4 py-2.5 rounded-xl bg-accent text-white border border-accent hover:bg-accent-hover disabled:opacity-50 transition-all duration-fast"
                >
                  {loading ? "..." : "Preview"}
                </button>
              </div>
            </div>

            {/* Preview */}
            {preview && (
              <div className="border border-border/50 rounded-xl p-4 space-y-3 bg-surface-light/30">
                <div className="flex items-center gap-3">
                  {preview.icon ? (
                    <img src={preview.icon} alt="" className="w-12 h-12 rounded-lg object-cover" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-accent/20 flex items-center justify-center text-accent text-lg font-bold">
                      {preview.displayName[0]}
                    </div>
                  )}
                  <div>
                    <div className="font-semibold text-text">{preview.displayName}</div>
                    <div className="text-sm text-text-dim">by {preview.author}</div>
                  </div>
                  {preview.version && (
                    <span className="ml-auto text-xs px-2 py-1 rounded-full bg-accent/10 text-accent border border-accent/20">
                      v{preview.version}
                    </span>
                  )}
                </div>
                {preview.description && (
                  <p className="text-sm text-text-dim">{preview.description}</p>
                )}
                {preview.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {preview.tags.map((tag) => (
                      <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-surface-light text-text-dim border border-border/30">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Folder Name */}
                <div className="space-y-1.5">
                  <label className="text-sm text-text-dim">Install folder name</label>
                  <input
                    type="text"
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-[rgba(15,15,26,0.6)] text-text text-sm outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
                    disabled={installing}
                  />
                </div>

                <button
                  onClick={handleInstall}
                  disabled={!folderName.trim() || installing}
                  className="w-full px-4 py-2.5 rounded-xl bg-accent text-white border border-accent hover:bg-accent-hover disabled:opacity-50 transition-all duration-fast"
                >
                  {installing ? "Installing..." : "Install"}
                </button>
              </div>
            )}
          </>
        ) : (
          /* Post-install: Security Review Prompt */
          <div className="space-y-4 text-center">
            <div className="text-success text-3xl">&#10003;</div>
            <p className="text-text">
              <strong>{preview?.displayName}</strong> installed successfully.
            </p>
            <p className="text-sm text-text-dim">
              Run a security review on this imported persona?
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => onClose()}
                className="px-4 py-2 rounded-lg bg-transparent border border-border text-text-dim hover:bg-surface-light transition-all duration-fast"
              >
                Skip
              </button>
              <button
                onClick={handleSecurityReview}
                className="px-4 py-2.5 rounded-xl bg-accent text-white border border-accent hover:bg-accent-hover transition-all duration-fast"
              >
                Open Builder for Review
              </button>
            </div>
          </div>
        )}

        {error && <p className="text-error text-sm">{error}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ImportPersonaModal.tsx
git commit -m "feat: add ImportPersonaModal component"
```

---

## Task 7: Publish Persona Modal

URL 직접 입력 or 빌더 세션으로 진행을 선택하는 모달.

**Files:**
- Create: `src/components/PublishPersonaModal.tsx`

- [ ] **Step 1: Create PublishPersonaModal component**

```tsx
// src/components/PublishPersonaModal.tsx
"use client";

import { useState, useCallback, useEffect } from "react";

interface Props {
  open: boolean;
  personaName: string;
  onClose: () => void;
  onOpenBuilder: (name: string, initialMessage: string) => void;
}

export default function PublishPersonaModal({ open, personaName, onClose, onOpenBuilder }: Props) {
  const [url, setUrl] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!open) {
      setUrl("");
      setError("");
      setSuccess(false);
    }
  }, [open]);

  const handleDirectPublish = useCallback(async () => {
    if (!url.trim()) return;
    setPublishing(true);
    setError("");
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(personaName)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Publish failed");
        return;
      }
      setSuccess(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setPublishing(false);
    }
  }, [url, personaName]);

  const handleBuilderPublish = useCallback(() => {
    onOpenBuilder(
      personaName,
      "이 페르소나를 GitHub에 퍼블리시해줘. 리포 생성, remote 설정, persona.json 생성, .gitignore 확인, push까지 진행해줘."
    );
    onClose();
  }, [personaName, onOpenBuilder, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[12px] z-[100] flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-2xl w-full max-w-md p-6 space-y-5 animate-[slideUp_0.25s_ease-out]">
        <h2 className="text-lg font-semibold text-text">Publish Persona</h2>

        {!success ? (
          <>
            {/* Option A: Direct URL */}
            <div className="space-y-2">
              <label className="text-sm text-text-dim">GitHub repo URL (already created)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleDirectPublish()}
                  placeholder="https://github.com/user/my-persona"
                  className="flex-1 px-4 py-2.5 border border-border rounded-xl bg-[rgba(15,15,26,0.6)] text-text outline-none transition-all duration-fast focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]"
                  disabled={publishing}
                />
                <button
                  onClick={handleDirectPublish}
                  disabled={!url.trim() || publishing}
                  className="px-4 py-2.5 rounded-xl bg-accent text-white border border-accent hover:bg-accent-hover disabled:opacity-50 transition-all duration-fast"
                >
                  {publishing ? "..." : "Push"}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-text-dim">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Option B: Builder Session */}
            <button
              onClick={handleBuilderPublish}
              className="w-full px-4 py-3 rounded-xl border border-border text-text hover:bg-surface-light transition-all duration-fast text-left"
            >
              <div className="font-medium">Builder session</div>
              <div className="text-sm text-text-dim mt-0.5">
                AI handles repo creation, setup & push
              </div>
            </button>
          </>
        ) : (
          <div className="text-center space-y-3">
            <div className="text-success text-3xl">&#10003;</div>
            <p className="text-text">Published successfully!</p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover transition-all duration-fast"
            >
              Done
            </button>
          </div>
        )}

        {error && <p className="text-error text-sm">{error}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/PublishPersonaModal.tsx
git commit -m "feat: add PublishPersonaModal component"
```

---

## Task 8: Builder Page — initialMessage Query Param

빌더 페이지에 `initialMessage` 쿼리 파라미터 지원 추가. 페이지 로드 시 해당 메시지를 자동 전송.

**Files:**
- Modify: `src/app/builder/[name]/page.tsx`

- [ ] **Step 1: Add initialMessage handling**

빌더 페이지에서 `searchParams`에서 `initialMessage`를 읽어, 세션 초기화 후 자동으로 `sendMessage`를 호출한다.

기존 코드에서 세션 초기화 완료 후 opening message를 추가하는 부분 근처에 다음을 추가:

```typescript
// After WS connection is established and history is loaded:
const initialMessage = searchParams.get("initialMessage");
```

그리고 `useEffect` 안에서 WS 연결 + 히스토리 로드 완료 후:

```typescript
// Auto-send initialMessage if provided (for publish/security review flows)
const initialMsgSent = useRef(false);

useEffect(() => {
  const msg = searchParams.get("initialMessage");
  if (msg && !initialMsgSent.current && wsConnected && !isStreaming) {
    initialMsgSent.current = true;
    // Small delay to ensure session is fully ready
    setTimeout(() => sendMessage(decodeURIComponent(msg)), 500);
  }
}, [searchParams, wsConnected, isStreaming, sendMessage]);
```

Exact implementation depends on existing variable names in the builder page — check `wsConnected` or equivalent state variable, and the `sendMessage` function reference.

- [ ] **Step 2: Commit**

```bash
git add src/app/builder/[name]/page.tsx
git commit -m "feat: support initialMessage query param in builder page"
```

---

## Task 9: Lobby UI — Import Button + Update Check

로비 페이지에 Import 버튼과 PersonaCard에 업데이트 체크 기능 추가.

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/PersonaCard.tsx`

- [ ] **Step 1: Add Import button and modal to lobby page**

`src/app/page.tsx`에서:

1. Import 추가:
```typescript
import ImportPersonaModal from "@/components/ImportPersonaModal";
```

2. State 추가:
```typescript
const [importOpen, setImportOpen] = useState(false);
```

3. 핸들러 추가:
```typescript
const handleImported = useCallback((name: string) => {
  loadPersonas(); // Re-fetch persona list
}, [loadPersonas]);

const handleOpenBuilder = useCallback((name: string, initialMessage: string) => {
  router.push(`/builder/${encodeURIComponent(name)}?mode=edit&initialMessage=${encodeURIComponent(initialMessage)}`);
}, [router]);
```

4. "새 페르소나 만들기" 카드 옆에 Import 버튼 카드 추가:
```tsx
<div
  onClick={() => setImportOpen(true)}
  className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/50 hover:border-accent/50 cursor-pointer transition-all duration-fast min-h-[140px] text-text-dim hover:text-accent"
>
  <span className="text-2xl">&#8615;</span>
  <span className="text-sm">Import from GitHub</span>
</div>
```

5. 모달 렌더링:
```tsx
<ImportPersonaModal
  open={importOpen}
  onClose={() => setImportOpen(false)}
  onImported={handleImported}
  onOpenBuilder={handleOpenBuilder}
/>
```

- [ ] **Step 2: Update PersonaCard to show import status and update check**

`src/components/PersonaCard.tsx`에서:

1. Props에 추가:
```typescript
interface Props {
  // ... existing props
  importMeta?: {
    source: string;
    url: string;
    installedAt: string;
    installedCommit: string;
  };
  onCheckUpdate?: () => void;
  updateStatus?: "checking" | "up-to-date" | "update-available" | null;
  behindCount?: number;
}
```

2. Import 뱃지 표시 (카드 하단에):
```tsx
{importMeta && (
  <div className="flex items-center gap-1.5 mt-1">
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
      imported
    </span>
    {onCheckUpdate && (
      <button
        onClick={(e) => { e.stopPropagation(); onCheckUpdate(); }}
        className="text-[10px] px-1.5 py-0.5 rounded bg-surface-light text-text-dim hover:text-text border border-border/30 transition-colors"
        title="Check for updates"
      >
        {updateStatus === "checking" ? "..." :
         updateStatus === "update-available" ? `${behindCount} updates` :
         updateStatus === "up-to-date" ? "up to date" :
         "check update"}
      </button>
    )}
  </div>
)}
```

3. 업데이트 가능 시 스타일링:
```tsx
// update-available 상태일 때 버튼에 accent 색상 적용
updateStatus === "update-available" && "!text-accent !border-accent/30 !bg-accent/10"
```

- [ ] **Step 3: Wire up update check in lobby page**

`src/app/page.tsx`에서:

```typescript
const [updateStatuses, setUpdateStatuses] = useState<Record<string, { status: string; behindCount?: number }>>({});

const handleCheckUpdate = useCallback(async (name: string) => {
  setUpdateStatuses((prev) => ({ ...prev, [name]: { status: "checking" } }));
  try {
    const res = await fetch(`/api/personas/${encodeURIComponent(name)}/check-update`, { method: "POST" });
    const data = await res.json();
    if (data.upToDate) {
      setUpdateStatuses((prev) => ({ ...prev, [name]: { status: "up-to-date" } }));
    } else {
      setUpdateStatuses((prev) => ({ ...prev, [name]: { status: "update-available", behindCount: data.behindCount } }));
    }
  } catch {
    setUpdateStatuses((prev) => ({ ...prev, [name]: { status: "error" } }));
  }
}, []);
```

PersonaCard에 전달:
```tsx
<PersonaCard
  // ...existing props
  importMeta={p.importMeta}
  onCheckUpdate={p.importMeta ? () => handleCheckUpdate(p.name) : undefined}
  updateStatus={updateStatuses[p.name]?.status}
  behindCount={updateStatuses[p.name]?.behindCount}
/>
```

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx src/components/PersonaCard.tsx
git commit -m "feat: add import button and update check to lobby UI"
```

---

## Task 10: Publish Button on PersonaCard

PersonaCard에 Publish 버튼 추가 (import되지 않은 로컬 페르소나용).

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/PersonaCard.tsx`

- [ ] **Step 1: Add publish button to PersonaCard**

`PersonaCard.tsx` Props에 추가:
```typescript
onPublish?: () => void;
```

Edit 버튼 옆에 Publish 버튼 추가 (import된 페르소나가 아닌 경우에만):
```tsx
{onPublish && !importMeta && (
  <button
    onClick={(e) => { e.stopPropagation(); onPublish(); }}
    className="opacity-100 md:opacity-0 md:group-hover:opacity-100 p-1.5 rounded-lg text-text-dim hover:text-accent hover:bg-accent/10 transition-all duration-fast"
    title="Publish to GitHub"
  >
    &#8613;
  </button>
)}
```

- [ ] **Step 2: Add PublishPersonaModal to lobby page**

`src/app/page.tsx`에서:

```typescript
import PublishPersonaModal from "@/components/PublishPersonaModal";

const [publishTarget, setPublishTarget] = useState<string | null>(null);
```

PersonaCard에 전달:
```tsx
onPublish={() => setPublishTarget(p.name)}
```

모달 렌더링:
```tsx
<PublishPersonaModal
  open={!!publishTarget}
  personaName={publishTarget || ""}
  onClose={() => setPublishTarget(null)}
  onOpenBuilder={handleOpenBuilder}
/>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx src/components/PersonaCard.tsx
git commit -m "feat: add publish button to PersonaCard"
```

---

## Task 11: Update Flow — Builder Session with Auto-Message

업데이트 가능 시 빌더 세션으로 이동하여 업데이트 + 보안 점검을 수행하는 흐름.

**Files:**
- Modify: `src/components/PersonaCard.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Add update action to PersonaCard**

`PersonaCard.tsx` Props에 추가:
```typescript
onUpdate?: () => void;
```

업데이트 가능 상태일 때 버튼을 클릭하면 `onUpdate` 호출:
```tsx
{updateStatus === "update-available" && onUpdate && (
  <button
    onClick={(e) => { e.stopPropagation(); onUpdate(); }}
    className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors"
  >
    Update in Builder
  </button>
)}
```

- [ ] **Step 2: Wire up update handler in lobby**

`src/app/page.tsx`에서:

```typescript
const handleUpdate = useCallback((name: string) => {
  const msg = "이 페르소나는 외부에서 가져온 것이며 원본 리포에 업데이트가 있습니다. origin에서 최신 변경사항을 pull 받아주세요. 완료 후 보안 점검도 진행할까요?";
  router.push(`/builder/${encodeURIComponent(name)}?mode=edit&initialMessage=${encodeURIComponent(msg)}`);
}, [router]);
```

PersonaCard에 전달:
```tsx
onUpdate={updateStatuses[p.name]?.status === "update-available" ? () => handleUpdate(p.name) : undefined}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx src/components/PersonaCard.tsx
git commit -m "feat: add update flow via builder session"
```

---

## Task 12: .gitignore Template for Personas

Publish 시 자동으로 적용되는 `.gitignore`가 새로 만들어지는 페르소나에도 기본 포함되도록.

**Files:**
- Modify: `src/lib/session-manager.ts`

- [ ] **Step 1: Add default .gitignore in createPersonaDir**

`createPersonaDir()` 메서드에서 디렉토리 생성 후 `.gitignore` 파일 작성:

```typescript
// After creating directories and before ensureClaudeRuntimeConfig:
const gitignoreContent = [
  "# Excluded from publish",
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
  "",
].join("\n");
fs.writeFileSync(path.join(dir, ".gitignore"), gitignoreContent, "utf-8");
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/session-manager.ts
git commit -m "feat: add default .gitignore to new personas for publish support"
```

---

## Task 13: AI Guide — Publish Skill Document

빌더 세션에서 AI가 publish 절차를 참조할 수 있는 가이드 문서.

**Files:**
- Create: `data/shared-documents/publish-guide.md`

- [ ] **Step 1: Check shared documents pattern**

Run: `ls data/shared-documents/` to see existing shared doc structure and how they're referenced.

Then check `docs/shared-documents.md` for how shared documents are assembled into builder sessions.

- [ ] **Step 2: Create publish guide document**

The content should cover:
1. `persona.json` 생성/업데이트 절차
2. `.gitignore` 확인 (민감 파일 제외)
3. GitHub MCP 활용 시: 리포 생성 → remote 설정 → push
4. 수동 방식: 유저에게 remote URL 입력 안내
5. 이미 remote가 있는 경우: push만 실행

Exact file path and content depend on the shared documents pattern discovered in step 1.

- [ ] **Step 3: Create security review guide document**

보안 점검 가이드:
1. `tools/*.js` — `require('child_process')`, `eval()`, `fs.writeFileSync` 등 위험 패턴 검색
2. `hooks/on-message.js` — 동일한 패턴 검색
3. `panels/*.html` — `<script src=`, `fetch(`, `XMLHttpRequest`, 외부 URL 참조
4. `session-instructions.md` — 비정상적 시스템 프롬프트 조작 시도

- [ ] **Step 4: Commit**

```bash
git add data/shared-documents/
git commit -m "docs: add publish guide and security review guide for builder AI"
```

---

## Task 14: Final Integration Test

전체 흐름을 수동으로 테스트.

- [ ] **Step 1: Test Import flow**

1. 앱 실행 (`npm run dev`)
2. 로비에서 "Import from GitHub" 클릭
3. 유효한 GitHub URL 입력 → Preview 확인
4. 폴더명 확인 → Install 클릭
5. 보안 점검 제안 확인
6. 설치된 페르소나가 로비에 나타나는지 확인
7. "imported" 뱃지 표시 확인

- [ ] **Step 2: Test Publish flow**

1. 로컬 페르소나 카드에서 Publish 버튼 확인
2. URL 직접 입력 방식 테스트 (미리 만든 빈 리포 사용)
3. 빌더 세션으로 진행 방식 테스트 → 자동 메시지 주입 확인

- [ ] **Step 3: Test Update Check flow**

1. import된 페르소나에서 "check update" 버튼 클릭
2. 상태 표시 확인 (up-to-date 또는 update-available)
3. 업데이트 가능 시 "Update in Builder" 버튼 → 빌더 이동 + 자동 메시지 확인

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes for persona sharing"
```
