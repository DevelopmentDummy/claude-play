"use client";

import { useState, useRef, useCallback, useEffect, memo } from "react";
import { createPortal } from "react-dom";
import { showToast } from "./ToastEffect";
import { getPanelActionRegistry } from "@/lib/panel-action-registry";
import { FOCUS_PANEL_EVENT } from "@/lib/use-panel-bridge";
import { isResidentPlacement, resolvePanelPlacement } from "@/lib/stage-layout";
import UsageIndicator from "./UsageIndicator";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import type { Choice } from "./ChatMessages";


/** 자동 마이크: 조건이 갖춰진 뒤 켜기까지의 지연(연속 이벤트 흡수). */
const VOICE_ARM_DELAY_MS = 400;
/** 자동 TTS가 켜져 있을 때 턴 종료 후 첫 음성을 기다리는 최대 시간. 응답에 대사가 없으면 이만큼 늦게 켜진다. */
const TTS_START_GRACE_MS = 4000;

/** Choice button with portal-based tooltip that escapes overflow clipping */
function ChoiceButton({ choice, busy, onChoice, sessionId }: { choice: Choice; busy: boolean; onChoice: (c: Choice) => void; sessionId?: string }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const actionLabel = choice.actions?.length ? choice.actions.map(a => {
    if (a.panel && sessionId) {
      if (a.action === "__open") return `${a.panel} 열기`;
      if (a.action === "__close") return `${a.panel} 닫기`;
      const reg = getPanelActionRegistry(sessionId);
      return reg.getLabel(a.panel, a.action) || reg.getLabelByAction(a.action) || a.action;
    }
    // Tool action: try to find a readable label from args.action
    const toolAction = a.args?.action as string | undefined;
    if (toolAction && sessionId) {
      const reg = getPanelActionRegistry(sessionId);
      return reg.getLabelByAction(toolAction) || toolAction.replace(/_/g, " ");
    }
    return a.action || a.tool || "";
  }).join(" → ") : "";

  useEffect(() => {
    if (hover && btnRef.current && actionLabel) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.top });
    }
  }, [hover, actionLabel]);

  return (
    <>
      <button
        ref={btnRef}
        disabled={busy}
        onClick={() => onChoice(choice)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={`relative px-3.5 py-2 rounded-xl text-sm text-text bg-[rgba(15,15,26,0.6)]
          border cursor-pointer
          transition-all duration-fast
          active:translate-y-0
          ${choice.dry
            ? "border-[rgba(var(--accent-rgb),0.35)] bg-[rgba(var(--accent-rgb),0.04)] hover:border-[rgba(var(--accent-rgb),0.6)] hover:bg-[rgba(var(--accent-rgb),0.10)] hover:-translate-y-px hover:shadow-[0_2px_12px_rgba(var(--accent-rgb),0.15)]"
            : "border-border/60 hover:border-accent hover:bg-[rgba(var(--accent-rgb),0.08)] hover:-translate-y-px hover:shadow-[0_2px_12px_var(--accent-glow)]"
          }
          ${choice.actions?.length ? "pr-7" : ""}
          ${busy ? "opacity-50 pointer-events-none" : ""}`}
      >
        {choice.text}
        {choice.actions && choice.actions.length > 0 && (
          <span className={`absolute -top-1.5 -right-1.5 flex items-center gap-px px-1 py-0.5 rounded-full text-[10px] leading-none border ${
            choice.dry
              ? "bg-accent/30 text-accent border-accent/40"
              : "bg-accent/20 text-accent border-accent/30"
          }`}>
            {choice.dry ? (
              <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 1A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 13.5 1h-11zM3 3.5A.5.5 0 0 1 3.5 3h4a.5.5 0 0 1 0 1h-4A.5.5 0 0 1 3 3.5zM3 6a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9A.5.5 0 0 1 3 6zm0 2.5A.5.5 0 0 1 3.5 8h9a.5.5 0 0 1 0 1h-9A.5.5 0 0 1 3 8.5z"/></svg>
            ) : (
              <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg>
            )}
            {choice.actions.length > 1 && <span>{choice.actions.length}</span>}
          </span>
        )}
      </button>
      {hover && actionLabel && pos && createPortal(
        <div
          style={{ left: pos.x, top: pos.y }}
          className="fixed -translate-x-1/2 -translate-y-full -mt-2 px-2.5 py-1.5
            rounded-lg text-xs whitespace-nowrap pointer-events-none z-[9999]
            bg-[rgba(20,16,32,0.95)] text-[#e0e0e0] border border-[rgba(var(--accent-rgb),0.2)]
            shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
        >
          <span className="opacity-70 mr-1">{choice.dry ? "◇" : "⚙"}</span>{actionLabel}
        </div>,
        document.body
      )}
    </>
  );
}

interface ChatInputProps {
  disabled: boolean;
  isStreaming?: boolean;
  onSend: (text: string) => void;
  onCancel?: () => void;
  sessionId?: string;
  choices?: Choice[];
  pendingEvents?: string[];
  showOOC?: boolean;
  onOOCToggle?: (on: boolean) => void;
  /** Voice chat mode: auto-start STT after AI response, auto-send after silence */
  voiceChat?: boolean;
  /** TTS is currently playing audio */
  ttsPlaying?: boolean;
  /** 자동 TTS가 켜져 있음 — 턴 종료 후 음성이 곧 재생될 수 있으니 자동 마이크가 그걸 기다린다 */
  ttsExpected?: boolean;
  /** Auto-send delay in ms (default 3000) */
  autoSendDelay?: number;
  /** Autoplay mode active */
  autoplayActive?: boolean;
  /** Toggle autoplay on/off */
  onAutoplayToggle?: () => void;
  /** 턴 중 개입(interject) 허용 여부 — true면 스트리밍 중에도 Send가 살아있다 */
  interjectActive?: boolean;
  /** 개입 토글 (미지정이면 토글 칩 자체를 렌더하지 않는다 — 빌더는 상시 허용) */
  onInterjectToggle?: () => void;
  /** Currently selected steering preset name */
  steeringPresetName?: string | null;
  /** Open steering preset editor */
  onSteeringEdit?: () => void;
  /** Usage indicator */
  usageProvider?: "claude" | "codex" | "gemini" | "antigravity";
  usageSessionId?: string;
  usageRefreshTrigger?: number;
  onUsageClick?: () => void;
  /** 좁은 컬럼용 압축 배치 (무대 레이아웃 채팅 컬럼). 메인 행은 [입력창][전송/중지], 나머지 버튼은 둘째 행. */
  compact?: boolean;
}

function ChatInput({ disabled, isStreaming, onSend, onCancel, sessionId, choices, pendingEvents, showOOC, onOOCToggle, voiceChat, ttsPlaying, ttsExpected, autoSendDelay = 3000, autoplayActive, onAutoplayToggle, interjectActive, onInterjectToggle, steeringPresetName, onSteeringEdit, usageProvider, usageSessionId, usageRefreshTrigger, onUsageClick, compact = false }: ChatInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [oocMode, setOocMode] = useState(false);
  const [choiceBusy, setChoiceBusy] = useState(false);
  // Track consumed dry choices to remove them from UI after click
  const [consumedDryTexts, setConsumedDryTexts] = useState<Set<string>>(new Set());
  const oocModeRef = useRef(oocMode);
  oocModeRef.current = oocMode;
  // Reset consumed dry choices when choices prop changes (new message / new choices)
  const choicesKey = choices?.map(c => c.text).join("\0");
  useEffect(() => { setConsumedDryTexts(new Set()); }, [choicesKey]);
  const composingRef = useRef(false);
  // --- 음성 입력 (엔진: useVoiceInput) ---
  const insertRef = useRef<(text: string) => void>(() => {});
  const voiceInsertedRef = useRef(false); // 음성 결과가 입력창에 들어감 → 전송 시 [STT] 태그
  /** 자동 마이크 재무장 금지 — 전송 직후(스트리밍 시작 전 틈)와 사용자가 자동 마이크를 직접 끈 경우. 다음 턴 시작 때 풀린다. */
  const autoBlockedRef = useRef(false);
  const voice = useVoiceInput({
    inputRef,
    sessionId,
    autoSendDelay,
    onInsert: (text) => { insertRef.current(text); voiceInsertedRef.current = true; },
    onAutoSend: (text) => {
      autoBlockedRef.current = true;
      const tagged = `[STT] ${text}`;
      onSend(oocModeRef.current && !tagged.startsWith("OOC:") ? `OOC: ${tagged}` : tagged);
    },
  });

  // Sync oocMode when showOOC changes externally (e.g. sync OOC message)
  useEffect(() => {
    if (showOOC !== undefined && showOOC !== oocMode) {
      setOocMode(showOOC);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOOC]);

  const handleSend = useCallback(() => {
    // 진행 중인 음성 세션은 버린다(web 엔진이 받아쓴 글은 입력창에 남아 그대로 전송된다).
    const wasSTT = voice.state === "listening" || voiceInsertedRef.current;
    voiceInsertedRef.current = false;
    autoBlockedRef.current = true;
    voice.cancel();
    const raw = inputRef.current?.value.trim();
    if (!raw) return;
    const tagged = wasSTT ? `[STT] ${raw}` : raw;
    const text = oocModeRef.current && !tagged.startsWith("OOC:") ? `OOC: ${tagged}` : tagged;
    onSend(text);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }
  }, [onSend, voice]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME 조합 중에는 Enter 무시 (한글 등 조합형 입력기)
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Refocus textarea when streaming ends (disabled → enabled)
  // 윈도우가 비활성일 때 focus()를 호출하면 macOS IME 상태가 깨질 수 있으므로
  // document.hasFocus() 체크 후, 비활성이면 visibilitychange로 지연
  useEffect(() => {
    if (!disabled) {
      if (document.hasFocus() && !composingRef.current) {
        requestAnimationFrame(() => inputRef.current?.focus());
      } else {
        // 윈도우가 비활성일 때는 다시 활성화될 때 포커스
        const onVisible = () => {
          if (document.visibilityState === "visible" && !composingRef.current) {
            requestAnimationFrame(() => inputRef.current?.focus());
            document.removeEventListener("visibilitychange", onVisible);
          }
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
      }
    }
  }, [disabled]);

  const handleInput = useCallback(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }
  }, []);

  const executeChoiceActions = useCallback(async (choice: Choice, sessionId: string) => {
    const registry = getPanelActionRegistry(sessionId);
    const win = window as unknown as Record<string, unknown>;
    let lastAvailable: Array<{ action: string; label: string; args_hint: string | null }> | null = null;

    for (const act of choice.actions!) {
      if (act.panel) {
        // ═══ Panel Action ═══

        // 배치 조회 — __layout은 layout.json 원본이라 placement는 panels.placement에 있다(구형 최상위 placement 폴백).
        // 사이드바·무대(left/right/main) 패널은 화면에 상주하므로 모달 열기/닫기를 보내지 않는다.
        // main이면 무대 탭으로 전환한다. dock 계열은 __modals로 표시되므로 기존처럼 연다.
        const placement = resolvePanelPlacement(registry.getLayout(), act.panel);
        const resident = isResidentPlacement(placement);
        const focusStageTab = () => {
          if (placement === "main") {
            window.dispatchEvent(new CustomEvent(FOCUS_PANEL_EVENT, { detail: { name: act.panel } }));
          }
        };

        // Built-in __open / __close: directly control modal without handler
        if (act.action === "__open" || act.action === "__close") {
          if (resident) {
            if (act.action === "__open") focusStageTab();
            continue;
          }
          await fetch(`/api/sessions/${sessionId}/modals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: act.action === "__open" ? "open" : "close",
              name: act.panel,
              ...(act.action === "__open" ? { mode: "dismissible" } : {}),
            }),
          });
          continue;
        }

        focusStageTab();

        // Suppress handler's sendMessage — choice text will be sent via onSend instead
        win.__panelActionSuppressSend = true;
        // Signal panels that an action is about to execute
        win.__panelActionExecuting = `${act.panel}.${act.action}`;
        window.dispatchEvent(new CustomEvent("__panel_action_executing", {
          detail: `${act.panel}.${act.action}`
        }));

        // 1. Check handler and UI requirements
        const hasHandler = registry.hasHandler(act.panel, act.action);
        const needsUI = registry.needsUI(act.panel, act.action); // defaults to true

        // 2. Open modal if: (a) handler not registered yet, or (b) action needs_ui and modal isn't active
        const modalsState = win.__panelModalsState as Record<string, boolean | string> | undefined;
        const isActive = modalsState ? !!modalsState[act.panel] : false;
        const needsOpen = !resident && (!hasHandler || (needsUI && !isActive));
        if (needsOpen) {
          const mode = placement === "modal-dismissible" ? "dismissible" : true;
          await fetch(`/api/sessions/${sessionId}/modals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "open", name: act.panel, mode }),
          });
          // Brief delay for modal to become visible (UI animations need it)
          if (needsUI) await new Promise(r => setTimeout(r, 150));
        }

        // 3. Wait for handler registration only if not already registered
        if (!hasHandler) {
          await registry.waitForHandler(act.panel, act.action, 8000);
        }

        // 4. Execute via registry (records to history + runs handler)
        //    sendMessage inside handler is suppressed; queueEvent still works
        const params = act.params || act.args;
        await registry.execute(act.panel, act.action, params);
        win.__panelActionExecuting = null;

        // 5. If we opened the modal just for this action, close it after execution
        //    For dry choices, keep dismissible modals open (user likely wants to interact)
        if (needsOpen && !choice.dry) {
          await fetch(`/api/sessions/${sessionId}/modals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "close", name: act.panel }),
          });
        }

      } else if (act.tool) {
        // ═══ Legacy Tool Action ═══
        // Wrap inner params separately to avoid key collision (e.g. besra_evening's params.action vs outer action)
        const innerParams = act.params || act.args || {};
        const toolBody = { args: { action: act.action, params: innerParams } };
        console.log("[choice tool action] sending:", JSON.stringify(toolBody));
        const toolRes = await fetch(`/api/sessions/${sessionId}/tools/${encodeURIComponent(act.tool)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toolBody),
        });
        if (!toolRes.ok) {
          const err = await toolRes.json().catch(() => ({ error: "Action failed" }));
          console.error("[choice tool action] error:", err);
          throw new Error(err.error || `Action ${act.action} failed`);
        }
        const toolData = await toolRes.json();
        console.log("[choice tool action] response:", JSON.stringify(toolData));
        const r = toolData.result;
        const hint = r?.hints?.narrative || r?.hints?.summary
          || (Array.isArray(r?.hints) && r.hints.length > 0 ? r.hints[0] : null)
          || r?.reason || r?.message || "completed";
        await fetch(`/api/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ header: `[${act.action}] ${hint}` }),
        });
        if (toolData._available_actions?.length) {
          lastAvailable = toolData._available_actions;
        }
      }
    }

    // [AVAILABLE] header is already queued in sendMessage — skip here to avoid duplicates

    return lastAvailable;
  }, []);

  const handleChoice = useCallback(async (choice: Choice) => {
    // No actions and not dry: just send text
    if (!choice.actions?.length || !sessionId) {
      if (!choice.dry) {
        onSend(choice.text);
      }
      return;
    }

    setChoiceBusy(true);
    const win = window as unknown as Record<string, unknown>;
    try {
      await executeChoiceActions(choice, sessionId);

      // Clear suppress flag
      win.__panelActionSuppressSend = false;

      if (choice.dry) {
        // Dry choice: actions executed, no message sent to AI — remove from UI
        showToast(choice.text, 2000);
        setConsumedDryTexts(prev => new Set(prev).add(choice.text));
      } else {
        // Normal choice: send choice text as user message
        onSend(choice.text);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      console.error("[choice action]", msg);
      showToast(msg, 4000);
    } finally {
      win.__panelActionSuppressSend = false;
      setChoiceBusy(false);
    }
  }, [onSend, sessionId, executeChoiceActions]);

  const insertAtCursor = useCallback((text: string) => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = el.value.substring(0, start);
    const after = el.value.substring(end);
    el.value = before + text + after;
    el.selectionStart = el.selectionEnd = start + text.length;
    const fit = () => {
      el.focus();
      // Trigger height adjustment
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    };
    // 무대 레이아웃에서 채팅이 접혀 있거나 모바일 무대 뷰라 입력창이 display:none이면
    // 지금은 높이를 잴 수 없고(scrollHeight 0 → 0px로 찌그러짐) 포커스도 안 된다.
    // fillInput을 받은 쪽이 채팅을 펼친 뒤(다음 프레임들) 맞춘다.
    if (el.getClientRects().length > 0) {
      fit();
      return;
    }
    let frames = 0;
    const retry = () => {
      if (el.getClientRects().length > 0) fit();
      else if (++frames < 10) requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  }, []);

  // Listen for panel bridge fillInput events
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (typeof text === "string") {
        insertAtCursor(text);
      }
    };
    window.addEventListener("__panel_fill_input", handler);
    return () => window.removeEventListener("__panel_fill_input", handler);
  }, [insertAtCursor]);

  insertRef.current = insertAtCursor;

  // --- 음성 대화 정책 ---
  // 자동 마이크는 "턴이 완전히 끝난 뒤"에만 켠다.
  //  1) 스트리밍 중엔 안 켠다 — 턴 중 개입이 켜져 입력창이 살아 있어도(disabled=false) 마찬가지.
  //  2) TTS 재생 중엔 안 켠다.
  //  3) 자동 TTS가 켜져 있으면 턴 종료 후 첫 음성이 시작될 때까지 기다린다(TTS_START_GRACE_MS).
  //     턴 종료~첫 오디오 사이 틈에 켜면 스피커로 나오는 AI 음성을 녹음해 그대로 전사한다
  //     (2026-10-07 실측 — STT가 AI 대사와 문맥 머리말을 사용자 입력으로 보냈다).
  // 자동 세션은 스트리밍이나 TTS가 시작되면 즉시 버린다. 수동 세션은 사용자가 끈다.
  const turnIdle = !isStreaming && !disabled && !ttsPlaying;
  /** 이번 턴이 끝난 뒤 AI 음성이 한 번 재생을 마쳤나 — 사용자 메시지 낭독(스트리밍 중 재생)은 세지 않는다. */
  const ttsHeardRef = useRef(false);
  const prevTtsPlayingRef = useRef(!!ttsPlaying);
  useEffect(() => {
    if (isStreaming) { ttsHeardRef.current = false; autoBlockedRef.current = false; }
  }, [isStreaming]);
  useEffect(() => {
    if (prevTtsPlayingRef.current && !ttsPlaying && !isStreaming) ttsHeardRef.current = true;
    prevTtsPlayingRef.current = !!ttsPlaying;
  }, [ttsPlaying, isStreaming]);

  const { state: voiceState, handsFree: voiceHandsFree, mode: voiceMode, start: voiceStart, cancel: voiceCancel } = voice;

  // 턴·TTS가 시작되면 자동 세션은 버리고, 입력이 막히면(개입 OFF 스트리밍·compact) 수동 세션도 버린다.
  useEffect(() => {
    if (voiceState !== "listening") return;
    if (disabled || (voiceHandsFree && !turnIdle)) voiceCancel();
  }, [disabled, turnIdle, voiceState, voiceHandsFree, voiceCancel]);

  // 재무장 — 조건이 유지된 채 지연이 지나야 켠다. 지연 중 조건이 깨지면 cleanup이 타이머를 지운다.
  useEffect(() => {
    if (!voiceChat || !turnIdle || voiceState !== "idle" || voiceMode === "none" || autoBlockedRef.current) return;
    const delay = ttsExpected && !ttsHeardRef.current ? TTS_START_GRACE_MS : VOICE_ARM_DELAY_MS;
    const t = setTimeout(() => {
      if (!autoBlockedRef.current) voiceStart({ handsFree: true });
    }, delay);
    return () => clearTimeout(t);
  }, [voiceChat, turnIdle, voiceState, voiceMode, voiceStart, ttsExpected]);

  const toggleVoice = useCallback(() => {
    if (voiceState === "listening") {
      // 직접 끈 자동 세션은 다음 턴까지 다시 켜지 않는다. 녹음기는 전사해 입력창에 넣는다.
      autoBlockedRef.current = true;
      voice.stop();
    } else if (voiceState === "idle") {
      voice.start({ handsFree: !!voiceChat && turnIdle });
    }
  }, [voiceState, voice, voiceChat, turnIdle]);

  const btnBase = "w-9 h-9 flex items-center justify-center rounded-lg border cursor-pointer text-xs font-medium shrink-0 transition-all duration-fast";

  // 입력 영역 컨트롤 — 기본 배치와 압축 배치(compact)가 같은 요소를 위치만 바꿔 쓴다.
  const oocButton = (
    <button
      type="button"
      aria-pressed={oocMode}
      onClick={() => {
        const next = !oocMode;
        setOocMode(next);
        onOOCToggle?.(next);
      }}
      className={`${btnBase} ${
        oocMode
          ? "border-yellow-500/60 text-yellow-400 bg-yellow-500/15"
          : showOOC
            ? "border-yellow-500/30 text-yellow-400/60 bg-transparent hover:border-yellow-500/50 hover:text-yellow-400/80"
            : "border-border/40 text-text-dim/60 bg-transparent hover:border-border/60 hover:text-text-dim/80"
      }`}
      title={oocMode ? "OOC 모드 끄기" : "OOC 모드 켜기"}
    >
      OOC
    </button>
  );
  const starButton = (
    <button
      onClick={() => insertAtCursor("*")}
      className={`${btnBase} border-border/40 text-text-dim/60 bg-transparent hover:border-border/60 hover:text-text-dim/80`}
      title="* 삽입 (행동 묘사)"
    >
      *
    </button>
  );
  const voiceListening = voiceState === "listening";
  const voiceTranscribing = voiceState === "transcribing";
  const sttButton = voiceMode !== "none" && (
    <button
      type="button"
      aria-pressed={voiceListening}
      aria-label={voiceTranscribing ? "변환 중" : voiceListening ? "음성 입력 중지" : "음성 입력"}
      onClick={toggleVoice}
      disabled={voiceTranscribing}
      className={`${btnBase} relative ${
        voiceTranscribing
          ? "border-blue-500/60 text-blue-400 bg-blue-500/15 animate-pulse"
          : voiceListening
            ? "border-red-500/60 text-red-400 bg-red-500/15 animate-pulse"
            : "border-border/40 text-text-dim/60 bg-transparent hover:border-border/60 hover:text-text-dim/80"
      }`}
      title={voiceTranscribing ? "변환 중..." : voiceListening ? "음성 입력 중지" : "음성 입력"}
    >
      {/* Auto-send countdown ring */}
      {voice.countdown && (
        <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
          <circle
            cx="18" cy="18" r="15"
            fill="none"
            stroke="rgba(96,165,250,0.3)"
            strokeWidth="2"
          />
          <circle
            cx="18" cy="18" r="15"
            fill="none"
            stroke="rgb(96,165,250)"
            strokeWidth="2.5"
            strokeDasharray={`${Math.PI * 30}`}
            strokeDashoffset="0"
            strokeLinecap="round"
            style={{
              animation: `stt-countdown ${autoSendDelay}ms linear forwards`,
            }}
          />
        </svg>
      )}
      {voiceTranscribing ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
          <circle cx="12" cy="12" r="3"/>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm-1-9a1 1 0 1 1 2 0v6a1 1 0 1 1-2 0V5zm6 6a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11h-2z"/>
        </svg>
      )}
    </button>
  );
  const textarea = (
    <textarea
      ref={inputRef}
      aria-label={oocMode ? "OOC 메시지 입력" : "메시지 입력"}
      disabled={disabled}
      placeholder={oocMode ? "OOC 메시지..." : "Type a message..."}
      rows={1}
      className={`flex-1 px-3.5 py-2.5 border rounded-xl bg-[rgba(15,15,26,0.6)] text-text font-[inherit] text-sm resize-none outline-none max-h-[150px] transition-all duration-fast focus:shadow-[0_0_0_3px_var(--accent-glow)] ${
        oocMode
          ? "border-yellow-500/40 focus:border-yellow-500/60"
          : "border-border focus:border-accent"
      }${compact ? " min-w-0" : ""}`}
      onKeyDown={handleKeyDown}
      onInput={handleInput}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      autoFocus
    />
  );
  const stopButton = isStreaming && onCancel && (
    compact ? (
      <button
        type="button"
        onClick={onCancel}
        aria-label="중지"
        title="중지"
        className="w-10 h-10 flex items-center justify-center border border-error/60 rounded-xl bg-error/15 text-error cursor-pointer shrink-0 transition-all duration-fast hover:bg-error/25 hover:-translate-y-px"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      </button>
    ) : (
      <button
        onClick={onCancel}
        className="px-5 py-2.5 border border-error/60 rounded-xl bg-error/15 text-error cursor-pointer text-sm font-medium shrink-0 transition-all duration-fast hover:bg-error/25 hover:-translate-y-px"
      >
        Stop
      </button>
    )
  );
  const sendButton = !(isStreaming && disabled) && (
    compact ? (
      <button
        type="button"
        disabled={disabled}
        onClick={handleSend}
        aria-label="전송"
        title="전송"
        className="w-10 h-10 flex items-center justify-center border-none rounded-xl bg-accent text-white cursor-pointer shrink-0 shadow-[0_2px_12px_var(--accent-glow)] transition-all duration-fast hover:bg-accent-hover hover:-translate-y-px hover:shadow-[0_4px_20px_var(--accent-glow)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4" aria-hidden>
          <path d="M3.4 20.4 21 12 3.4 3.6 3.39 10.1 15 12 3.39 13.9z" />
        </svg>
      </button>
    ) : (
      <button
        disabled={disabled}
        onClick={handleSend}
        className="px-5 py-2.5 border-none rounded-xl bg-accent text-white cursor-pointer text-sm font-medium shrink-0 shadow-[0_2px_12px_var(--accent-glow)] transition-all duration-fast hover:bg-accent-hover hover:-translate-y-px hover:shadow-[0_4px_20px_var(--accent-glow)] disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none"
      >
        Send
      </button>
    )
  );
  const autoplayButton = (
    <button
      type="button"
      aria-pressed={!!autoplayActive}
      aria-label={autoplayActive ? "오토플레이 중지" : "오토플레이 시작"}
      onClick={onAutoplayToggle}
      className={`${btnBase} relative ${
        autoplayActive
          ? "border-blue-500/60 text-blue-400 bg-blue-500/15 shadow-[0_0_8px_rgba(59,130,246,0.3)]"
          : "border-border/40 text-text-dim/60 bg-transparent hover:border-border/60 hover:text-text-dim/80"
      }`}
      title={autoplayActive ? "오토플레이 중지" : "오토플레이 시작"}
    >
      {autoplayActive ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
          <path d="M8 5v14l11-7z" />
        </svg>
      )}
    </button>
  );
  const usageIndicator = usageProvider && (
    <UsageIndicator
      provider={usageProvider}
      sessionId={usageSessionId}
      refreshTrigger={usageRefreshTrigger}
      onClick={onUsageClick}
    />
  );
  const interjectButton = onInterjectToggle && (
    <button
      type="button"
      aria-pressed={!!interjectActive}
      onClick={onInterjectToggle}
      title={interjectActive
        ? "턴 중 개입 켜짐 — AI가 응답하는 도중에도 메시지를 보낼 수 있습니다"
        : "턴 중 개입 꺼짐 — AI 응답이 끝난 뒤에만 입력할 수 있습니다"}
      className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
        interjectActive
          ? "border-blue-500/50 text-blue-400/90 bg-blue-500/10"
          : "border-border/40 text-text-dim/50 hover:text-text-dim/80 hover:border-border/60"
      }`}
    >
      턴 중 개입 {interjectActive ? "ON" : "OFF"}
    </button>
  );
  const steeringLabel = <span className="text-[11px] text-text-dim/50">오토 메시지:</span>;
  const steeringButton = (
    <button
      onClick={onSteeringEdit}
      className={`text-[11px] truncate max-w-[200px] transition-colors ${
        steeringPresetName
          ? "text-blue-400/70 hover:text-blue-300"
          : "text-text-dim/50 hover:text-text-dim/80"
      }`}
    >
      {steeringPresetName || "없음"}
    </button>
  );

  return (
    <footer className="flex flex-col bg-surface backdrop-blur-[16px] border-t border-border shrink-0">
      {choices && choices.length > 0 && !disabled && (() => {
        const visible = choices.filter(c => !(c.dry && consumedDryTexts.has(c.text)));
        return visible.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1 max-h-[30vh] overflow-y-auto">
            {visible.map((c, i) => (
              <ChoiceButton key={i} choice={c} busy={choiceBusy} onChoice={handleChoice} sessionId={sessionId} />
            ))}
          </div>
        ) : null;
      })()}
      {pendingEvents && pendingEvents.length > 0 && !isStreaming && !disabled && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-2 pb-1 max-h-[100px] overflow-y-auto">
          {pendingEvents.map((header, i) => (
            <span
              key={i}
              className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs
                bg-amber-500/10 text-amber-300/90 border border-amber-500/20"
            >
              {header}
            </span>
          ))}
        </div>
      )}
      {/* 메인 행 — 압축 배치(compact)에서는 [입력창][중지/전송]만 남겨 좁은 컬럼에서도 입력창 폭을 확보한다.
          입력창은 두 배치에서 같은 자리를 유지해 전환돼도 다시 마운트되지 않는다(작성 중 텍스트 보존). */}
      <div className={compact ? "flex items-end gap-2 px-3 pt-2.5 pb-1.5" : "flex items-end gap-2 px-4 py-3"}>
        {/* Left toolbar: OOC toggle + * insert */}
        {!compact && (
          <div className="flex gap-1 shrink-0 pb-0.5">
            {oocButton}
            {starButton}
            {sttButton}
          </div>
        )}
        {textarea}
        {stopButton}
        {/* 개입 허용(=스트리밍 중에도 disabled=false)이면 Stop과 Send를 함께 노출 */}
        {sendButton}
        {/* Autoplay toggle */}
        {!compact && autoplayButton}
      </div>
      {compact ? (
        /* 둘째 행: 보조 버튼 + 사용량·턴 중 개입·오토 메시지 — 기능은 그대로, 위치만 옮기고 줄바꿈 허용 */
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 pb-2">
          <div className="flex gap-1 shrink-0">
            {oocButton}
            {starButton}
            {sttButton}
            {autoplayButton}
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1 min-w-0">
            {usageIndicator}
            {interjectButton}
            {steeringLabel}
            {steeringButton}
          </div>
        </div>
      ) : (
        /* Bottom bar: usage (left) + steering (right) */
        <div className="flex items-center justify-between px-4 pb-2 -mt-1">
          {/* Usage indicator (left) */}
          <div className="flex items-center">
            {usageIndicator}
          </div>
          {/* Steering preset (right) */}
          <div className="flex items-center gap-2">
            {interjectButton}
            {steeringLabel}
            {steeringButton}
          </div>
        </div>
      )}
    </footer>
  );
}

// React.memo로 감싸서 props가 실제로 변하지 않으면 리렌더 방지
// → AI 스트리밍 중 부모(ChatPage)가 매 text_delta마다 리렌더되더라도
//   ChatInput의 textarea DOM은 건드리지 않으므로 IME 상태 보존
export default memo(ChatInput);
