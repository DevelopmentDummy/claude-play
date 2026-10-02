"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import ImageModal from "./ImageModal";
import { installImagePolling } from "@/lib/panel-image-polling";
import { isMountOncePanel, stripPanelActions, stripPanelMeta } from "@/lib/panel-action-registry";
import { createLiveBridgeProxy, releaseBridgeSubs } from "@/lib/use-panel-bridge";

interface InlinePanelProps {
  html: string;
  sessionId?: string;
}

export default function InlinePanel({ html, sessionId }: InlinePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [modalSrc, setModalSrc] = useState<string | null>(null);
  // mount-once 패널은 처음 한 번만 그린다 — 이후 html 변경은 무시 (stage-layout spec §6.2)
  const mountedOnceRef = useRef(false);
  // 패널 스크립트가 __panelBridge.on()으로 건 구독 해제 함수 — 재렌더·언마운트 때 해제한다
  const bridgeUnsubsRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
    }
  }, []);

  const renderContent = useCallback(() => {
    const shadow = shadowRef.current;
    if (!shadow) return;
    if (mountedOnceRef.current) return;
    mountedOnceRef.current = isMountOncePanel(html);

    releaseBridgeSubs(bridgeUnsubsRef.current);
    shadow.innerHTML =
      `<style>:host{font-family:inherit;font-size:inherit;line-height:inherit;color:inherit;white-space:normal;display:block;}img{cursor:zoom-in;}</style>` +
      stripPanelMeta(stripPanelActions(html));

    // Execute <script> tags via Function() with shadow reference
    // 스크립트의 __panelBridge는 조회 시점의 브리지를 따른다 (spec §6.3)
    // 인라인은 모달이 아니므로 sendMessage는 모달 래핑 전 원본을 쓴다(rawSend)
    const liveBridge = createLiveBridgeProxy((unsub) => bridgeUnsubsRef.current.push(unsub), { rawSend: true });
    const scripts = Array.from(shadow.querySelectorAll("script:not([type]), script[type='text/javascript']"));
    for (const oldScript of scripts) {
      oldScript.remove();
      try {
        let code = oldScript.textContent || "";
        // Remove full declaration to avoid TDZ collision with Function("shadow", ...) parameter
        code = code.replace(/(?:const|let|var)\s+shadow\s*=\s*document\.currentScript\??\.getRootNode\??\(\)\s*;?/g, "");
        code = code.replace(/document\.currentScript\??\.getRootNode\??\(\)/g, "shadow");
        const fn = new Function("shadow", "__panelBridge", code);
        fn(shadow, liveBridge);
      } catch (e) {
        console.warn("[InlinePanel] Script error:", e);
      }
    }

    // Auto-poll images that haven't loaded yet (deferred generation)
    installImagePolling(shadow);

    // Intercept image clicks inside shadow DOM
    shadow.addEventListener("click", (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "IMG") {
        const src = (target as HTMLImageElement).src;
        if (src) { e.preventDefault(); setModalSrc(src); }
        return;
      }
      const anchor = target.closest("a");
      if (anchor) {
        const href = anchor.getAttribute("href") || "";
        if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(href)) {
          e.preventDefault();
          setModalSrc(anchor.href);
        }
      }
    });
  }, [html]);

  useEffect(() => {
    renderContent();
  }, [renderContent]);

  // 언마운트 시 구독 해제. StrictMode 모의 언마운트→재마운트에서 다시 그려지도록 mount-once 표식도 되돌린다.
  useEffect(() => {
    const subs = bridgeUnsubsRef.current;
    return () => {
      releaseBridgeSubs(subs);
      mountedOnceRef.current = false;
    };
  }, []);

  return (
    <>
      <div
        ref={containerRef}
        style={{ display: 'contents' }}
        data-session-id={sessionId}
      />
      {modalSrc && <ImageModal src={modalSrc} onClose={() => setModalSrc(null)} />}
    </>
  );
}
