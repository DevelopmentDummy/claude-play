import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices, openSessionInstance, closeSessionInstance } from "@/lib/services";
import { getAppRoot } from "@/lib/data-dir";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string; model?: string };
  const { name } = body;
  const { model, effort } = parseModelEffort(body.model || "");
  const svc = getServices();

  // Close any existing builder instance for this persona
  closeSessionInstance(name);

  const provider = providerFromModel(model || "");
  const instance = openSessionInstance(name, true, provider);
  instance.clearHistory();

  // Add builder opening message
  const opening = "안녕하세요! 새로운 페르소나를 함께 만들어볼까요?\n\n이름, 성격, 말투, 배경 설정 등 원하는 것을 자유롭게 알려주세요. 구체적일수록 좋지만, 간단한 아이디어만 있어도 괜찮아요 — 대화하면서 함께 다듬어 나갈 수 있습니다.";
  instance.addOpeningToHistory(opening);

  const personaDir = svc.sessions.createPersonaDir(name);
  svc.sessions.ensureClaudeRuntimeConfig(personaDir, name, "builder");

  // Check Local TTS availability for conditional builder prompt
  const gpuManagerPort = parseInt(process.env.GPU_MANAGER_PORT || String((parseInt(process.env.PORT || "3340", 10)) + 2), 10);
  let localTtsAvailable = false;
  try {
    const healthRes = await fetch(`http://127.0.0.1:${gpuManagerPort}/health`, { signal: AbortSignal.timeout(2000) });
    if (healthRes.ok) {
      const health = await healthRes.json();
      localTtsAvailable = health.tts_available === true;
    }
  } catch { /* GPU Manager unavailable */ }

  // Copy builder prompt as both CLAUDE.md and AGENTS.md
  const builderPrompt = svc.sessions.getBuilderPrompt({ localTtsAvailable });
  fs.writeFileSync(path.join(personaDir, "CLAUDE.md"), builderPrompt, "utf-8");
  fs.writeFileSync(path.join(personaDir, "AGENTS.md"), builderPrompt, "utf-8");
  fs.writeFileSync(path.join(personaDir, "GEMINI.md"), builderPrompt, "utf-8");

  // Copy panel-spec.md
  const panelSpecSrc = path.join(getAppRoot(), "panel-spec.md");
  if (fs.existsSync(panelSpecSrc)) {
    fs.copyFileSync(panelSpecSrc, path.join(personaDir, "panel-spec.md"));
  }

  // Copy guide docs
  for (const guideFile of ["publish-guide.md", "security-review-guide.md"]) {
    const guideSrc = path.join(getAppRoot(), guideFile);
    if (fs.existsSync(guideSrc)) {
      fs.copyFileSync(guideSrc, path.join(personaDir, guideFile));
    }
  }

  instance.panels.watch(personaDir);

  const runtimeSystemPrompt = svc.sessions.buildBuilderSystemPrompt(name);
  // For Codex: write instructions file (file-based prompt delivery via model_instructions_file)
  if (provider === "codex") {
    svc.sessions.writeCodexInstructions(personaDir, runtimeSystemPrompt);
  } else if (provider === "gemini") {
    svc.sessions.writeGeminiInstructions(personaDir, runtimeSystemPrompt);
  }
  // Builder default effort: highest for each provider
  const effectiveEffort = effort || (provider === "codex" ? "xhigh" : provider === "gemini" ? undefined : "high");
  instance.claude.spawn(personaDir, undefined, model || undefined, runtimeSystemPrompt, effectiveEffort);

  const displayName = svc.sessions.getPersonaDisplayName(name);
  return NextResponse.json({ name, displayName, dir: personaDir, provider, opening });
}
