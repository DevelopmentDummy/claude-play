import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { writeSessionImage } from "./image-fs";

/**
 * Codex-backed image generation.
 *
 * Instead of calling the metered OpenAI image API, this drives the Codex CLI
 * (`codex exec`) which is authenticated via a ChatGPT subscription. Codex's
 * built-in `image_gen` tool renders the image (no OPENAI_API_KEY required — it
 * is covered by the subscription) and saves it under
 * `$CODEX_HOME/generated_images/<conversationId>/ig_*.png`. We snapshot that
 * directory before the run, then harvest the newly created file and copy it into
 * the session's `images/` directory.
 *
 * Trade-offs vs the direct API (see callers): slower (a full agent turn) and
 * counts against the ChatGPT plan's rate limits rather than per-call billing.
 */

interface GenerateRequest {
  prompt: string;
  filename: string;
  sessionDir: string;
  referenceImage?: string;
  size?: string;
  quality?: string;
}

interface GenerateResult {
  success: boolean;
  filepath?: string;
  error?: string;
}

const CODEX_TIMEOUT_MS = 420_000;
// After the process exits (or is killed), the image_gen tool may flush its
// ig_*.png slightly later. Poll for the fresh file for a short grace window
// before declaring failure, instead of scanning exactly once.
const HARVEST_RETRY_ATTEMPTS = 10;
const HARVEST_RETRY_DELAY_MS = 1_500;

/** Root directory where Codex's built-in image_gen tool saves outputs. */
function codexGeneratedImagesDir(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "generated_images");
}

/** Collect absolute paths of all existing `ig_*.png` files across conversation subdirs. */
function listIgImages(root: string): Set<string> {
  const out = new Set<string>();
  let convDirs: string[];
  try {
    convDirs = fs.readdirSync(root);
  } catch {
    return out; // dir may not exist yet
  }
  for (const d of convDirs) {
    const dir = path.join(root, d);
    let files: string[];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.startsWith("ig_") && f.endsWith(".png")) out.add(path.join(dir, f));
    }
  }
  return out;
}

export class CodexImageClient {
  /** Resolve+validate a reference image path inside the session dir. */
  private resolveReferenceImage(sessionDir: string, refPath: string): string | null {
    const base = path.resolve(sessionDir);
    const resolved = path.resolve(base, refPath);
    if (!resolved.startsWith(base) || !fs.existsSync(resolved)) return null;
    return resolved;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    // Validate reference image early (edit mode).
    let refAbs: string | null = null;
    if (req.referenceImage) {
      refAbs = this.resolveReferenceImage(req.sessionDir, req.referenceImage);
      if (!refAbs) {
        return { success: false, error: `Reference image not found or outside session: ${req.referenceImage}` };
      }
    }

    const genRoot = codexGeneratedImagesDir();
    const before = listIgImages(genRoot);

    // Empty temp cwd so Codex does not pick up the project's AGENTS.md, and so a
    // copied reference image is reachable by a space-free relative path (the repo
    // path contains spaces, which break args under shell:true on Windows).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cp-codex-img-"));

    try {
      const args = ["exec", "--skip-git-repo-check", "-C", tmp];

      let refForPrompt = "";
      if (refAbs) {
        const localRef = path.join(tmp, `reference${path.extname(refAbs) || ".png"}`);
        fs.copyFileSync(refAbs, localRef);
        args.push("-i", path.basename(localRef)); // relative to cwd (tmp) — no spaces
        refForPrompt = "the attached reference image";
      }

      const sizeHint = req.size && req.size !== "auto" ? ` Target image size: ${req.size}.` : "";
      const prompt = refAbs
        ? `Immediately call your built-in image_gen tool exactly once — do not plan, explain, or write anything first. Edit ${refForPrompt} with these instructions: ${req.prompt}.${sizeHint} Use the built-in image_gen tool ONLY (never the CLI fallback scripts/image_gen.py or the OpenAI API). Do NOT create or modify any other files. As soon as the single image is saved, reply with only: DONE`
        : `Immediately call your built-in image_gen tool exactly once — do not plan, explain, or write anything first. Generate one image: ${req.prompt}.${sizeHint} Use the built-in image_gen tool ONLY (never the CLI fallback scripts/image_gen.py or the OpenAI API). Do NOT create or modify any files in the working directory. As soon as the single image is saved, reply with only: DONE`;

      // Clean child env. Mirror codex-process.ts conventions, and crucially DROP
      // OPENAI_API_KEY so Codex can never fall back to the paid CLI path — the
      // built-in tool uses the ChatGPT subscription and needs no key.
      const env = { ...process.env, BROWSER: "" } as NodeJS.ProcessEnv;
      for (const key of Object.keys(env)) {
        if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) {
          delete (env as Record<string, string | undefined>)[key];
        }
      }
      delete (env as Record<string, string | undefined>).OPENAI_API_KEY;
      env.LANG = env.LANG || "en_US.UTF-8";
      env.LC_ALL = env.LC_ALL || "en_US.UTF-8";
      env.PYTHONIOENCODING = "utf-8";

      const cmd = process.platform === "win32" ? "codex.cmd" : "codex";

      const exit = await new Promise<{ ok: boolean; err?: string }>((resolve) => {
        let settled = false;
        const finish = (r: { ok: boolean; err?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        const proc = spawn(cmd, args, { env, cwd: tmp, stdio: ["pipe", "pipe", "pipe"], shell: true });
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* */ }
          finish({ ok: false, err: "codex exec timed out" });
        }, CODEX_TIMEOUT_MS);

        let stderrTail = "";
        proc.stdout?.on("data", () => { /* drain to avoid backpressure */ });
        proc.stderr?.on("data", (c: Buffer) => { stderrTail = (stderrTail + c.toString()).slice(-600); });
        proc.on("error", (e) => finish({ ok: false, err: `spawn failed: ${e.message}` }));
        proc.on("close", (code) => finish({ ok: code === 0, err: code === 0 ? undefined : `codex exited ${code}: ${stderrTail.trim()}` }));

        try { proc.stdin?.write(prompt); proc.stdin?.end(); } catch { /* */ }
      });

      // Harvest regardless of exit code — Codex sometimes exits non-zero after a
      // successful generation, and the ig_*.png can be flushed a few seconds
      // after the process closes. Poll for the fresh file across a short grace
      // window instead of scanning exactly once.
      let fresh: string[] = [];
      for (let attempt = 0; attempt < HARVEST_RETRY_ATTEMPTS; attempt++) {
        const after = listIgImages(genRoot);
        fresh = [...after].filter((p) => !before.has(p));
        if (fresh.length > 0) break;
        await new Promise((r) => setTimeout(r, HARVEST_RETRY_DELAY_MS));
      }
      if (fresh.length === 0) {
        return { success: false, error: exit.err || "Codex produced no image (no new ig_*.png found after grace window)" };
      }
      // NOTE: with concurrent generations this newest-new heuristic can mis-assign
      // between simultaneous calls; acceptable for a single-user service.
      fresh.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      const buffer = fs.readFileSync(fresh[0]);
      const filepath = writeSessionImage(req.sessionDir, req.filename, buffer);
      return { success: true, filepath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}
