// 런타임별 instruction 파일 writer (AGENTS.md/GEMINI.md 등). SessionManager에서 추출(Wave 12 cluster 2).
import * as fs from "fs";
import * as path from "path";

/**
 * Read session instructions from CLAUDE.md — the authoritative source that
 * Claude never overwrites with runtime prompts. Trimmed; "" if missing/unreadable.
 */
function readSessionInstructions(projectDir: string): string {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  try {
    if (fs.existsSync(claudeMdPath)) {
      return fs.readFileSync(claudeMdPath, "utf-8").trim();
    }
  } catch { /* ignore */ }
  return "";
}

/**
 * Merge session instructions with a runtime system prompt for CLIs that read a
 * single instruction file (Gemini/Kimi): CLAUDE.md content, separator, prompt.
 */
function combineInstructions(sessionInstructions: string, runtimePrompt: string): string {
  return sessionInstructions
    ? `${sessionInstructions}\n\n---\n\n${runtimePrompt}`
    : runtimePrompt;
}

/**
 * Write Codex model instructions file (.codex/model-instructions.md).
 * Called before spawning Codex to ensure file-based prompt delivery.
 */
export function writeCodexInstructions(projectDir: string, content: string): void {
  const codexDir = path.join(projectDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const instructionsPath = path.join(codexDir, "model-instructions.md");
  fs.writeFileSync(instructionsPath, content, "utf-8");
  console.log(`[codex] Wrote model instructions: ${instructionsPath} (${content.length} chars)`);
}

/**
 * Write GEMINI.md with session instructions + runtime system prompt combined.
 * Unlike Claude (which has separate CLAUDE.md + --system-prompt flag),
 * Gemini CLI only reads GEMINI.md — so both must be merged into one file.
 * Always reads CLAUDE.md as the authoritative source for session instructions,
 * since Claude never overwrites it with runtime prompts.
 */
export function writeGeminiInstructions(projectDir: string, runtimePrompt: string): void {
  const sessionInstructions = readSessionInstructions(projectDir);
  const combined = combineInstructions(sessionInstructions, runtimePrompt);

  const geminiMdPath = path.join(projectDir, "GEMINI.md");
  fs.writeFileSync(geminiMdPath, combined, "utf-8");
  console.log(`[gemini] Wrote GEMINI.md: ${projectDir} (${combined.length} chars, instructions: ${sessionInstructions.length})`);
}

/**
 * For Antigravity, the session primer is injected via `--prompt-interactive`
 * (first USER_INPUT step of the auto-cascade), and persona context goes into
 * GEMINI.md which agy auto-loads from the working directory.
 *
 * This writes ONLY the session instructions (persona/world/style/opening,
 * authoritatively from CLAUDE.md) — primer is NOT appended, since primer
 * arrives via the spawn arg path instead.
 */
export function writeAntigravityInstructions(projectDir: string): void {
  const sessionInstructions = readSessionInstructions(projectDir);

  const geminiMdPath = path.join(projectDir, "GEMINI.md");
  fs.writeFileSync(geminiMdPath, sessionInstructions, "utf-8");
  console.log(`[antigravity] Wrote GEMINI.md: ${projectDir} (${sessionInstructions.length} chars, persona-only)`);
}

/**
 * Write AGENTS.md with session instructions + runtime system prompt combined.
 * Kimi Code CLI loads AGENTS.md from the working directory.
 */
export function writeKimiInstructions(projectDir: string, runtimePrompt: string): void {
  const sessionInstructions = readSessionInstructions(projectDir);
  const combined = combineInstructions(sessionInstructions, runtimePrompt);

  const agentsMdPath = path.join(projectDir, "AGENTS.md");
  fs.writeFileSync(agentsMdPath, combined, "utf-8");
  console.log(`[kimi] Wrote AGENTS.md: ${projectDir} (${combined.length} chars, instructions: ${sessionInstructions.length})`);
}
