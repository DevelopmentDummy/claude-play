import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices, openSessionInstance } from "@/lib/services";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const rawModel = (body as { model?: string }).model || undefined;
  const { model, effort } = parseModelEffort(rawModel || "");
  const svc = getServices();

  const info = svc.sessions.getSessionInfo(id);
  if (!info) {
    return NextResponse.json(
      { error: `Session "${id}" not found` },
      { status: 404 }
    );
  }

  const sessionDir = svc.sessions.getSessionDir(id);

  // Determine the effective model and provider
  // rawModel may be saved as "opus:medium" — re-parse if loading from session
  const savedRaw = svc.sessions.getSessionModel(id) || "";
  const effectiveRaw = rawModel || savedRaw;
  const { model: effectiveModel, effort: effectiveEffort } = parseModelEffort(effectiveRaw);
  const finalEffort = effort || effectiveEffort;
  const provider = providerFromModel(effectiveModel);

  // Open (or reuse) session instance
  const instance = openSessionInstance(id, false, provider);

  // Start panel watching
  instance.panels.watch(sessionDir);

  // Read opening message (resolve Handlebars placeholders from variables.json + profile)
  const opening = svc.sessions.resolveOpening(sessionDir, info.profileSlug);

  // Read layout config
  const layout = svc.sessions.readLayout(sessionDir);

  // Refresh global tool skills (always sync on open — these are shared, not persona-specific)
  svc.sessions.refreshToolSkills(sessionDir);

  // Always copy latest panel-spec.md from project root
  svc.sessions.refreshPanelSpec(sessionDir);

  // Ensure runtime configs exist (but don't auto-sync persona files — user can manually sync)
  svc.sessions.ensureClaudeRuntimeConfig(sessionDir, info.persona, "session");

  // Resume previous session based on provider
  const resumeId = provider === "codex"
    ? svc.sessions.getCodexThreadId(id)
    : svc.sessions.getClaudeSessionId(id);
  const isResume = !!resumeId;
  instance.loadHistory(); // Load from chat-history.json (empty if new)

  // Save opening as first history entry for new sessions
  if (instance.chatHistory.length === 0 && opening) {
    instance.addOpeningToHistory(opening);
  }

  // Save model choice (with effort suffix) to session.json so it persists across refreshes
  if (rawModel) {
    svc.sessions.saveSessionModel(id, rawModel);
  }

  // Only spawn if process is not already running (avoid killing live process on page refresh)
  // Force respawn if user explicitly changed model
  const resolvedOptions = svc.sessions.resolveOptions(sessionDir);
  if (!instance.claude.isRunning() || rawModel) {
    const runtimeSystemPrompt = svc.sessions.buildServiceSystemPrompt(info.persona, provider, resolvedOptions);
    const skipPerms = resolvedOptions.skipPermissions !== false;
    instance.claude.spawn(sessionDir, resumeId, effectiveModel || undefined, runtimeSystemPrompt, finalEffort, skipPerms);
  }

  // Include initial panels + context in response (SSE may not be connected yet)
  const { panels, context: panelContext, sharedPlacements, popups } = instance.panels.getCurrentPanels();

  // Sync profile/icon images from persona to session (may have been added after session creation)
  const imagesDir = path.join(sessionDir, "images");
  const personaDir = svc.sessions.getPersonaDir(info.persona);
  const personaImagesDir = path.join(personaDir, "images");
  if (fs.existsSync(personaImagesDir)) {
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
    for (const name of ["profile", "icon"]) {
      for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
        const src = path.join(personaImagesDir, `${name}${ext}`);
        const dst = path.join(imagesDir, `${name}${ext}`);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
        }
      }
    }
  }

  // Check for profile image and icon in images/ directory
  const profileExts = [".png", ".jpg", ".jpeg", ".webp"];
  let profileImage: string | null = null;
  let iconImage: string | null = null;
  for (const ext of profileExts) {
    if (!profileImage && fs.existsSync(path.join(imagesDir, `profile${ext}`))) {
      profileImage = `images/profile${ext}`;
    }
    if (!iconImage && fs.existsSync(path.join(imagesDir, `icon${ext}`))) {
      iconImage = `images/icon${ext}`;
    }
  }

  const voiceConfig = svc.sessions.readVoiceConfig(sessionDir);
  const voiceEnabled = voiceConfig?.enabled ?? false;

  return NextResponse.json({ ...info, opening, isResume, layout, panels, panelContext, sharedPlacements, popups: popups || [], profileImage, iconImage, model: effectiveRaw || "", provider, voiceEnabled, chatOptions: resolvedOptions });
}
