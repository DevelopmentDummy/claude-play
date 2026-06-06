import { ClaudeProcess } from "./claude-process";
import { CodexProcess } from "./codex-process";
import { GeminiProcess } from "./gemini-process";
import { KimiProcess } from "./kimi-process";
import { AntigravityProcess } from "./antigravity-process";
import { AIProvider } from "./ai-provider";

/** Union of all provider process classes. All share the same EventEmitter shape
 *  (message/status/error/sessionId/exit). */
export type AIProcess =
  | ClaudeProcess
  | CodexProcess
  | GeminiProcess
  | KimiProcess
  | AntigravityProcess;

/** Construct a provider-specific process. Provider is locked at session/sub creation. */
export function createProcess(provider: AIProvider): AIProcess {
  if (provider === "codex") return new CodexProcess();
  if (provider === "gemini") return new GeminiProcess();
  if (provider === "kimi") return new KimiProcess();
  if (provider === "antigravity") return new AntigravityProcess();
  return new ClaudeProcess();
}
