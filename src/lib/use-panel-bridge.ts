"use client";

import { useEffect } from "react";
import { getPanelActionRegistry, type PanelActionHandler } from "./panel-action-registry";
import { formatInlineHtml, type FormatInlineHtmlOptions } from "./inline-formatter";

/** Internal event prefix for bridge events dispatched on window */
const EVT_PREFIX = "__bridge_evt:";

/** `__panelBridge.focusPanel(name)`이 발송하는 window 이벤트 — detail: `{ name }`. 페이지가 처리한다. */
export const FOCUS_PANEL_EVENT = "__bridge_focus_panel";

/** Supported panel bridge event names */
type BridgeEvent = "turnStart" | "turnEnd" | "imageUpdated" | "stateChanged";

/**
 * Dispatch a bridge event from the app to panel scripts.
 * Called by ChatPage when relevant state changes happen.
 */
export function dispatchBridgeEvent(event: BridgeEvent, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(`${EVT_PREFIX}${event}`, { detail }));
}

type BridgeSubscribe = (event: string, handler: (detail?: unknown) => void) => () => void;

/** 브리지 이벤트 구독 — 브리지 객체와 무관하게 window 이벤트만으로 동작한다 (`bridge.on`과 같은 구현). */
function subscribeBridgeEvent(event: string, handler: (detail?: unknown) => void): () => void {
  const wrapped = (e: Event) => handler((e as CustomEvent).detail);
  window.addEventListener(`${EVT_PREFIX}${event}`, wrapped);
  return () => window.removeEventListener(`${EVT_PREFIX}${event}`, wrapped);
}

/** createLiveBridgeProxy()가 만든 프록시들 — window.__panelBridge에 프록시가 되꽂혀도 자기 자신을 따라가지 않게 한다. */
const liveBridgeProxies = new WeakSet<object>();
/** usePanelBridge가 마지막으로 꽂은 실제 브리지 객체 */
let lastRealBridge: Record<string | symbol, unknown> | undefined;
/**
 * 프록시 트랩 재진입 깊이. 패널 스크립트가 프록시를 프로토타입·대상으로 둔 래퍼를 window.__panelBridge에
 * 꽂으면(`Object.create(__panelBridge)`, `new Proxy(__panelBridge, {})`) 트랩 → 래퍼 → 트랩으로 무한 재귀가
 * 날 수 있다. 트랩 안에서 다시 들어오면 실제 브리지로 끊는다.
 */
let resolveDepth = 0;

/**
 * ModalPanel이 최상단 모달의 `sendMessage`를 "보내고 자기 모달 닫기"로 감쌀 때, 감싸기 전 원본을
 * 브리지 객체에 이 키(열거 불가)로 남긴다. 모달이 아닌 실행기(PanelSlot·DockPanel·InlinePanel)의
 * 프록시는 `rawSend` 옵션으로 이 원본을 써서, 사이드바·무대 패널의 전송이 엉뚱하게 모달을 닫지 않게 한다.
 */
export const RAW_SEND_KEY = "__rawSendMessage";

/** createLiveBridgeProxy의 onSubscribe로 모은 구독 해제 함수들을 모두 호출하고 배열을 비운다 (배열은 재사용). */
export function releaseBridgeSubs(subs: Array<() => void>): void {
  for (const unsub of subs.splice(0)) {
    try { unsub(); } catch { /* 이미 해제됐거나 실패해도 나머지는 계속 */ }
  }
}

function currentBridge(): Record<string | symbol, unknown> | undefined {
  // usePanelBridge가 꽂은 실제 브리지를 우선 따른다. window.__panelBridge는 패널 스크립트가 덮어쓸 수 있어
  // (예: 프록시나 그 래퍼를 되꽂기) 그대로 따라가면 프록시가 자기 자신을 조회해 무한 재귀에 빠질 수 있다.
  if (lastRealBridge) return lastRealBridge;
  const b = (window as unknown as Record<string, unknown>).__panelBridge;
  if (typeof b !== "object" || b === null || liveBridgeProxies.has(b)) return undefined;
  return b as Record<string | symbol, unknown>;
}

/**
 * 패널 스크립트에 넘기는 `__panelBridge` — **조회 시점의** 브리지(usePanelBridge가 마지막으로 꽂은 객체)를 따르는 프록시.
 *
 * `usePanelBridge`는 panelData가 바뀔 때마다 새 브리지 객체를 window에 꽂는다. 스크립트 실행 시점의
 * 객체를 그대로 넘기면 나중에 읽는 `__panelBridge.data`가 최초 값에 고정된다 (stage-layout spec §6.3).
 * `onSubscribe`를 주면 `on()` 구독의 해제 함수를 수집해 재렌더·언마운트 때 정리할 수 있다.
 * `opts.rawSend`면 `sendMessage`가 모달 래핑 전 원본(RAW_SEND_KEY)을 돌려준다 — 모달이 아닌 실행기용.
 */
export function createLiveBridgeProxy(
  onSubscribe?: (unsub: () => void) => void,
  opts?: { rawSend?: boolean },
): Record<string, unknown> {
  const fallback: Record<string | symbol, unknown> = {};
  // live()는 항상 트랩 안(guarded)에서 불린다 — 바깥 트랩이 깊이 1이므로 1보다 크면 재진입이다
  const live = () => (resolveDepth > 1 ? lastRealBridge : currentBridge()) ?? fallback;
  const guarded = <T,>(fn: () => T): T => {
    resolveDepth++;
    try { return fn(); } finally { resolveDepth--; }
  };
  const proxy = new Proxy(fallback, {
    get(_target, prop) {
      return guarded(() => getTrap(prop));
    },
    set(_target, prop, value) {
      return guarded(() => Reflect.set(live(), prop, value));
    },
    has(_target, prop) {
      return guarded(() => prop === "on" || Reflect.has(live(), prop));
    },
    ownKeys() {
      return guarded(() => Reflect.ownKeys(live()));
    },
    getOwnPropertyDescriptor(_target, prop) {
      return guarded(() => {
        const desc = Reflect.getOwnPropertyDescriptor(live(), prop);
        // 프록시 불변식: 대상(fallback)에 없는 속성은 configurable이어야 보고할 수 있다.
        return desc ? { ...desc, configurable: true } : undefined;
      });
    },
  });
  function getTrap(prop: string | symbol): unknown {
    const bridge = live();
    if (prop === "sendMessage" && opts?.rawSend) {
      const raw = Reflect.get(bridge, RAW_SEND_KEY);
      if (typeof raw === "function") return raw;
    }
    if (prop === "on") {
      // 브리지가 잠시 없을 때(첫 커밋 전·InlinePanel 단독)도 구독은 window 이벤트로 바로 건다.
      const on: BridgeSubscribe = typeof bridge.on === "function"
        ? (bridge.on as BridgeSubscribe).bind(bridge)
        : subscribeBridgeEvent;
      return (event: string, handler: (detail?: unknown) => void) => {
        const unsub = on(event, handler);
        onSubscribe?.(unsub);
        return unsub;
      };
    }
    return Reflect.get(bridge, prop);
  }
  liveBridgeProxies.add(proxy);
  return proxy as Record<string, unknown>;
}

export function usePanelBridge(
  sessionId: string | undefined,
  panelData: Record<string, unknown> | undefined,
) {
  useEffect(() => {
    const bridge = {
      sendMessage(text: string, opts?: { silent?: boolean }) {
        const win = window as unknown as Record<string, unknown>;
        // Suppress during compound panel action execution
        if (win.__panelActionSuppressSend) {
          win.__panelActionSuppressedMsg = { text, opts };
          return;
        }
        const detail = opts?.silent ? { text, silent: true } : text;
        // If popups are playing/pending, queue the message for later delivery
        if (win.__popupsPlaying) {
          win.__pendingPanelMsg = detail;
          return;
        }
        window.dispatchEvent(new CustomEvent("__panel_send_message", { detail }));
      },
      /** Jev(TypeSafe System One) 빠른 판단. 키는 서버에만 있고 /api/jev 프록시를 거친다. */
      async jev(state: unknown, questions: Record<string, unknown>, model?: string) {
        const res = await fetch("/api/jev", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state, questions, ...(model ? { model } : {}) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `Jev request failed (${res.status})`);
        return data;
      },
      /** 임베딩·벡터 검색(EmbeddingGemma 2). action: search/upsert/index_dir/index_file/list/info/delete/drop/embed/warmup — `embedding` 스킬 참조. */
      async vectors(action: string, params?: Record<string, unknown>) {
        if (!sessionId) throw new Error("vectors() needs an active session");
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/vectors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(params ?? {}), action }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `vectors(${action}) failed (${res.status})`);
        return data;
      },
      fillInput(text: string) {
        window.dispatchEvent(new CustomEvent("__panel_fill_input", { detail: text }));
      },
      /** 패널로 시선을 옮긴다 — main 패널이면 무대 탭 전환, modal 계열이면 dismissible로 열기, 그 외 무시. */
      focusPanel(name: string) {
        if (typeof name !== "string" || !name) return;
        window.dispatchEvent(new CustomEvent(FOCUS_PANEL_EVENT, { detail: { name } }));
      },
      /** 패널 간 이벤트. 받는 쪽은 `on("panel:" + name, fn)` — 시스템 이벤트(turnEnd 등)와 네임스페이스가 분리돼 사칭할 수 없다. */
      emit(name: string, detail?: unknown) {
        if (typeof name !== "string" || !name) return;
        window.dispatchEvent(new CustomEvent(`${EVT_PREFIX}panel:${name}`, { detail }));
      },
      async updateVariables(patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/variables`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        return res.json();
      },
      async updateData(fileName: string, patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/variables?file=${encodeURIComponent(fileName)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        return res.json();
      },
      async updateLayout(patch: Record<string, unknown>) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/layout`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        return res.json();
      },
      async queueEvent(header: string) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ header }),
        });
        return res.json();
      },
      async runTool(toolName: string, args?: Record<string, unknown>) {
        if (!sessionId) return { ok: false, error: "No session" };
        const res = await fetch(`/api/sessions/${sessionId}/tools/${encodeURIComponent(toolName)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args: args || {} }),
        });
        return res.json();
      },
      /** Open a modal. Auto-closes other modals in the same group (defined in layout.json). */
      async openModal(name: string, mode?: "dismissible" | true) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/modals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "open", name, mode: mode ?? "dismissible" }),
        });
        return res.json();
      },
      /** Close a specific modal. */
      async closeModal(name: string) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/modals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "close", name }),
        });
        return res.json();
      },
      /** Close all modals, optionally keeping some open. */
      async closeAllModals(except?: string[]) {
        if (!sessionId) return;
        const res = await fetch(`/api/sessions/${sessionId}/modals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "closeAll", except }),
        });
        return res.json();
      },
      async showPopup(template: string, opts?: { duration?: number; vars?: Record<string, unknown> }) {
        if (!sessionId) return;
        // Signal that popups are pending — sendMessage will queue until playback finishes
        const win = window as unknown as Record<string, unknown>;
        win.__popupsPlaying = true;
        const existing = ((panelData || {}).__popups as Array<Record<string, unknown>>) || [];
        const entry: Record<string, unknown> = { template };
        if (opts?.duration) entry.duration = opts.duration;
        if (opts?.vars) entry.vars = opts.vars;
        const res = await fetch(`/api/sessions/${sessionId}/variables`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ __popups: [...existing, entry] }),
        });
        return res.json();
      },
      /** Show a toast notification (non-blocking, stacks in bottom-right corner). */
      showToast(text: string, opts?: { duration?: number }) {
        window.dispatchEvent(new CustomEvent("bridge:toast", {
          detail: { text, duration: opts?.duration || 3000 },
        }));
      },
      /** Show a confirm dialog. Returns a Promise<boolean> (true = confirmed, false = cancelled). */
      confirm(message: string, opts?: { yesText?: string; noText?: string }): Promise<boolean> {
        return new Promise((resolve) => {
          const yesText = opts?.yesText || "확인";
          const noText = opts?.noText || "취소";
          const overlay = document.createElement("div");
          overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;animation:__confirmFade 0.15s ease";
          overlay.innerHTML = `
            <style>@keyframes __confirmFade{from{opacity:0}to{opacity:1}}</style>
            <div style="background:#121829;border:1px solid var(--accent,#c8a44e);border-radius:8px;padding:16px 20px;min-width:240px;max-width:300px;font-family:'Segoe UI',sans-serif;color:#e0ddd4;box-shadow:0 4px 20px rgba(0,0,0,0.5)">
              <div style="font-size:13px;margin-bottom:14px;line-height:1.5;text-align:center">${message}</div>
              <div style="display:flex;gap:8px;justify-content:center">
                <button data-confirm="yes" style="padding:6px 20px;border-radius:5px;font-size:12px;cursor:pointer;font-family:'Segoe UI',sans-serif;border:1px solid var(--accent,#c8a44e);background:#1a2035;color:var(--accent,#c8a44e);transition:all 0.2s">${yesText}</button>
                <button data-confirm="no" style="padding:6px 20px;border-radius:5px;font-size:12px;cursor:pointer;font-family:'Segoe UI',sans-serif;border:1px solid #1e2a45;background:#0d1220;color:#7a7a8a;transition:all 0.2s">${noText}</button>
              </div>
            </div>`;
          const cleanup = (result: boolean) => { overlay.remove(); resolve(result); };
          overlay.querySelector("[data-confirm=yes]")!.addEventListener("click", () => cleanup(true));
          overlay.querySelector("[data-confirm=no]")!.addEventListener("click", () => cleanup(false));
          overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(false); });
          document.body.appendChild(overlay);
        });
      },
      /** Subscribe to a bridge event. Returns an unsubscribe function. */
      on(event: string, handler: (detail?: unknown) => void): () => void {
        return subscribeBridgeEvent(event, handler);
      },
      /** Register a panel action handler. panelName auto-detected from __currentPanelName or registry lookup. */
      registerAction(actionId: string, handler: PanelActionHandler, panelName?: string): void {
        if (!sessionId) return;
        const registry = getPanelActionRegistry(sessionId);
        const panel = panelName
          || (window as unknown as Record<string, unknown>).__currentPanelName as string
          || registry.findPanelByAction(actionId)
          || "";
        if (!panel) {
          console.warn("[panelBridge] registerAction: no panel name context for", actionId);
          return;
        }
        registry.registerHandler(panel, actionId, handler);
      },
      /** Execute a registered panel action. Records to history automatically. Panel auto-resolved from registry if not provided. */
      async executeAction(actionId: string, params?: Record<string, unknown>, panelName?: string): Promise<void> {
        if (!sessionId) return;
        const panel = panelName || (window as unknown as Record<string, unknown>).__currentPanelName as string || "";
        await getPanelActionRegistry(sessionId).execute(panel, actionId, params);
      },
      /** Format inline RP markdown (bold/italic/thought/code) to HTML with inline color styles.
       *  Use in panels (Shadow DOM) to render history/snippets with the same look as the main chat stream. */
      formatInline(text: string, opts?: FormatInlineHtmlOptions): string {
        return formatInlineHtml(text, opts);
      },
      sessionId,
      data: panelData || {},
      get isStreaming() {
        return !!(window as unknown as Record<string, unknown>).__bridgeIsStreaming;
      },
    };
    (window as unknown as Record<string, unknown>).__panelBridge = bridge;
    lastRealBridge = bridge;
    // sessionId is already set during getPanelActionRegistry(sessionId) creation
  }, [sessionId, panelData]);
}
