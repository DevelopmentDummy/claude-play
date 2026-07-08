import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { getServices, openSessionInstance } from "@/lib/services";
import { providerFromModel, parseModelEffort } from "@/lib/ai-provider";
import { consumeRestartMarker } from "@/lib/restart-notification";
import { getResumeIdForProvider, writeInstructionsForProvider } from "@/lib/respawn-helpers";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { model?: string; ttsAutoPlay?: boolean };
  const rawModel = body.model || undefined;
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
  const { model: effectiveModel, effort: effectiveEffort, advisor: effectiveAdvisor } = parseModelEffort(effectiveRaw);
  const finalEffort = effort || effectiveEffort;
  const provider = providerFromModel(effectiveModel);

  // Open (or reuse) session instance
  const instance = openSessionInstance(id, false, provider);

  // Apply client TTS preference immediately (before any AI response can trigger TTS)
  if (body.ttsAutoPlay !== undefined) {
    instance.ttsAutoPlay = !!body.ttsAutoPlay;
  }

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

  // Additive mirror: pick up files added to the persona template after the session
  // was created (opt-in hooks, new rules.md, etc.). Never overwrites existing
  // session files — RP state stays intact. Use case: user adds style-check.json +
  // hooks/on-style-check.js to the persona, reopens an existing session to enable.
  const personaDirForMirror = svc.sessions.getPersonaDir(info.persona);
  if (fs.existsSync(personaDirForMirror)) {
    svc.sessions.mirrorNewPersonaFiles(personaDirForMirror, sessionDir);
  }

  // Resume previous session based on provider
  let resumeId = getResumeIdForProvider(svc.sessions, id, provider);
  if (provider === "kimi" && !resumeId) {
    try {
      const { listConversationsForSession } = await import("@/lib/session-list");
      const latest = listConversationsForSession(id).items[0];
      if (latest?.conversationId) {
        resumeId = latest.conversationId;
        svc.sessions.saveKimiSessionId(id, resumeId);
      }
    } catch { /* best-effort backfill */ }
  }
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
    const profile = info.profileSlug ? svc.sessions.getProfile(info.profileSlug) : undefined;
    let runtimeSystemPrompt = svc.sessions.buildServiceSystemPrompt(info.persona, provider, resolvedOptions, profile?.name);
    // Append session-specific panel action definitions (if any). Static so the
    // prompt cache stays warm; the [정의] event handles per-error reminders.
    try {
      const { readPanelActionsMeta, formatPanelActionsAsMarkdown } = await import("@/lib/panel-actions-meta");
      const panelMeta = readPanelActionsMeta(sessionDir);
      const panelMarkdown = formatPanelActionsAsMarkdown(panelMeta);
      if (panelMarkdown) {
        runtimeSystemPrompt = `${runtimeSystemPrompt}\n\n${panelMarkdown}`;
      }
    } catch { /* optional — skip on failure */ }
    // Write provider-specific runtime instructions file (file-based prompt
    // delivery for codex/gemini/kimi; persona context for antigravity).
    writeInstructionsForProvider(svc.sessions, sessionDir, provider, runtimeSystemPrompt);
    const skipPerms = resolvedOptions.skipPermissions !== false;
    instance.claude.spawn(sessionDir, resumeId, effectiveModel || undefined, runtimeSystemPrompt, finalEffort, skipPerms, "claude-stream.log", effectiveAdvisor);
  }

  // Spawn always-on sub-agents declared in subagents.json (session mode only; builder has none).
  // Idempotent: re-open with subs already running is a no-op. Never throws into the open flow.
  if (!instance.isBuilder) {
    try { instance.subAgents.spawnAll(provider, effectiveModel || undefined, finalEffort); }
    catch (err) { console.error(`[open:${id}] subAgents.spawnAll failed:`, err); }
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

  // If this session triggered a service restart on the previous boot, deliver
  // the silent "restart completed" notification once the AI process is ready.
  // No-op when no marker exists. Atomic — safe under concurrent open calls.
  // Fire-and-forget: don't block the open response on the AI handshake.
  void consumeRestartMarker(sessionDir, instance);

  return NextResponse.json({ ...info, opening, isResume, layout, panels, panelContext, sharedPlacements, popups: popups || [], profileImage, iconImage, model: effectiveRaw || "", provider, voiceEnabled, chatOptions: resolvedOptions });
}
