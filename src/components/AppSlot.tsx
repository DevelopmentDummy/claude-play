"use client";

import { useRef, useEffect, useState } from "react";
import { usePanelBridge, dispatchBridgeEvent } from "@/lib/use-panel-bridge";

interface AppSlotProps {
  sessionId: string;
  /** 세션 디렉토리 기준 진입 HTML 경로 (예: "app/index.html") */
  entry: string;
  /** 상태 스냅샷 — 바뀌면 stateChanged 이벤트로 앱에 밀어넣는다 (재렌더하지 않는다) */
  panelData?: Record<string, unknown>;
}

/**
 * 앱 모드의 메인 슬롯. PanelSlot과 shadow DOM 기법은 같지만 정책이 반대다:
 * **한 번만 마운트하고 다시는 innerHTML을 쓰지 않는다.** 상태 변경은 이벤트로만 전달되므로
 * 앱의 rAF 루프·캔버스 컨텍스트·이벤트 리스너가 살아남는다 (spec §4.1).
 */
export default function AppSlot({ sessionId, entry, panelData }: AppSlotProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // 앱도 패널과 같은 __panelBridge를 쓴다 (postMessage 계층 없음 — spec §4.3).
  usePanelBridge(sessionId, panelData);

  // 1회 마운트: HTML을 가져와 shadow에 넣고 스크립트를 한 번 실행한다.
  useEffect(() => {
    if (mountedRef.current || !containerRef.current) return;
    mountedRef.current = true;
    const shadow = containerRef.current.attachShadow({ mode: "open" });

    let cancelled = false;
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/files/`;
    const isAbsolute = (u: string) => /^(https?:|data:|blob:|\/)/.test(u);
    // 앱 코드(HTML/스크립트)는 개발 중 수시로 바뀌는데 브라우저가 이전 응답을 재사용하면
    // 새 클라이언트와 새 서버 엔진이 어긋나 원인을 찾기 힘든 증상이 된다.
    // 마운트 시각을 쿼리로 붙여 코드만 확실히 새로 받는다 (이미지 등 나머지 자산은 캐시 유지).
    const bust = "?v=" + Date.now();

    void (async () => {
      try {
        const res = await fetch(base + entry + bust);
        if (!res.ok) throw new Error(`앱 진입 파일을 불러오지 못했습니다 (${res.status})`);
        const html = await res.text();
        if (cancelled) return;

        shadow.innerHTML = html;

        // 상대 경로 자산을 세션 파일 라우트로 돌린다.
        for (const el of Array.from(shadow.querySelectorAll<HTMLImageElement>("img[src]"))) {
          const src = el.getAttribute("src") || "";
          if (!isAbsolute(src)) el.setAttribute("src", base + src);
        }
        for (const el of Array.from(shadow.querySelectorAll<HTMLLinkElement>("link[href]"))) {
          const href = el.getAttribute("href") || "";
          if (!isAbsolute(href)) el.setAttribute("href", base + href);
        }

        // 스크립트는 DOM 삽입만으로는 실행되지 않으므로 직접 평가한다.
        // PanelSlot과 달리 이 실행은 앱 수명 동안 단 한 번뿐이다.
        const scripts = Array.from(
          shadow.querySelectorAll<HTMLScriptElement>(
            "script:not([type]), script[type='text/javascript'], script[type='module']",
          ),
        );
        for (const s of scripts) {
          const src = s.getAttribute("src");
          let code = s.textContent || "";
          if (src) {
            const url = isAbsolute(src) ? src : base + src;
            const r = await fetch(url + (isAbsolute(src) ? "" : bust));
            if (!r.ok) throw new Error(`앱 스크립트를 불러오지 못했습니다: ${src} (${r.status})`);
            code = await r.text();
          }
          if (cancelled) return;
          // 앱 오류가 셸을 죽이지 않도록 격리한다 (iframe 대신의 에러 격리, spec §4.2).
          try {
            new Function("shadow", "sessionId", code)(shadow, sessionId);
          } catch (err) {
            console.error("[AppSlot] 앱 스크립트 실행 오류:", err);
            setError(`앱 스크립트 오류: ${(err as Error).message}`);
          }
        }

        // 마운트 완료 후 최초 상태를 한 번 밀어준다.
        dispatchBridgeEvent("stateChanged", panelData ?? {});
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();

    return () => { cancelled = true; };
    // entry/sessionId가 바뀌면 그건 다른 세션이므로 페이지가 통째로 다시 마운트된다.
    // panelData는 의도적으로 의존성에서 제외한다 — 재마운트하면 앱 상태가 날아간다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, entry]);

  // 상태 변경은 재렌더가 아니라 이벤트로만 전달한다.
  useEffect(() => {
    if (!mountedRef.current) return;
    dispatchBridgeEvent("stateChanged", panelData ?? {});
  }, [panelData]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {error && (
        <div className="absolute left-0 right-0 top-0 z-10 bg-red-900/80 px-3 py-2 text-xs text-white">
          {error}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
