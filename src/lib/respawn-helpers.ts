import type { SessionManager } from "./session-manager";
import type { AIProvider } from "./ai-provider";

/**
 * Resolve the provider-specific resume id saved for a session, or undefined if
 * none. Mirrors the per-provider session-meta getters so the open/sync/options
 * respawn paths share one definition of "which id resumes this provider".
 */
export function getResumeIdForProvider(
  sm: SessionManager,
  id: string,
  provider: AIProvider,
): string | undefined {
  return provider === "codex"
    ? sm.getCodexThreadId(id)
    : provider === "gemini"
    ? sm.getGeminiSessionId(id)
    : provider === "kimi"
    ? sm.getKimiSessionId(id)
    : provider === "antigravity"
    ? sm.getAntigravityCascadeId(id)
    : sm.getClaudeSessionId(id);
}

/**
 * Write the provider-specific runtime instructions file before a (re)spawn.
 * Codex/Gemini/Kimi take the runtime system prompt; Antigravity writes persona
 * context into GEMINI.md (primer delivered separately via spawn); Claude needs
 * no file (prompt is delivered through spawn's append-system-prompt).
 */
export function writeInstructionsForProvider(
  sm: SessionManager,
  sessionDir: string,
  provider: AIProvider,
  runtimeSystemPrompt: string,
): void {
  if (provider === "codex") {
    sm.writeCodexInstructions(sessionDir, runtimeSystemPrompt);
  } else if (provider === "gemini") {
    sm.writeGeminiInstructions(sessionDir, runtimeSystemPrompt);
  } else if (provider === "kimi") {
    sm.writeKimiInstructions(sessionDir, runtimeSystemPrompt);
  } else if (provider === "antigravity") {
    sm.writeAntigravityInstructions(sessionDir);
  }
}
