"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PanelSlot from "./PanelSlot";

interface Panel {
  name: string;
  html: string;
}

interface MainStageProps {
  /** main 배치 패널 — 파일 순서 */
  panels: Panel[];
  sessionId: string;
  panelData: Record<string, unknown>;
  onSendMessage: (text: string) => void;
  /** 활성 탭 이름. 목록에 없거나 null이면 첫 탭 */
  activeName: string | null;
  onActiveChange: (name: string) => void;
}

/** 활성 탭 기억 키 — 세션별 */
export function stageTabStorageKey(sessionId: string): string {
  return `stageTab:${sessionId}`;
}

/**
 * 무대 활성 탭 상태 + localStorage 기억 (spec §5.3). 저장값이 목록에 없으면 MainStage가 첫 탭을 보인다.
 * SSR 불일치를 피하려고 저장값은 마운트 후에 읽는다.
 */
export function useStageTab(sessionId: string): [string | null, (name: string) => void] {
  const key = sessionId ? stageTabStorageKey(sessionId) : "";
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    try {
      setActive(window.localStorage.getItem(key));
    } catch { /* localStorage 접근 불가 환경 무시 */ }
  }, [key]);
  const select = useCallback((name: string) => {
    setActive(name);
    if (!key) return;
    try { window.localStorage.setItem(key, name); } catch { /* 무시 */ }
  }, [key]);
  return [active, select];
}

/**
 * 중앙 무대 — main 배치 패널을 탭으로 띄운다.
 * 비활성 탭도 마운트를 유지하고 display:none으로만 숨긴다 (shadow DOM·스크롤·입력 보존).
 */
export default function MainStage({ panels, sessionId, panelData, onSendMessage, activeName, onActiveChange }: MainStageProps) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const current = panels.some((p) => p.name === activeName) ? activeName : panels[0]?.name ?? null;
  const showTabs = panels.length > 1;

  // 좌우 화살표·Home/End로 탭 이동 (WAI-ARIA tabs 패턴, 자동 활성화)
  const handleTabKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % panels.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + panels.length) % panels.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = panels.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const name = panels[next].name;
    onActiveChange(name);
    tabRefs.current[name]?.focus();
  }, [panels, onActiveChange]);

  const tabId = (i: number) => `stage-tab-${i}`;
  const panelId = (i: number) => `stage-panel-${i}`;

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="무대">
      {showTabs && (
        <div
          role="tablist"
          aria-label="무대 패널"
          className="flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-surface px-2 backdrop-blur-[16px]"
        >
          {panels.map((p, i) => {
            const selected = p.name === current;
            return (
              <button
                key={p.name}
                ref={(el) => { tabRefs.current[p.name] = el; }}
                type="button"
                role="tab"
                id={tabId(i)}
                aria-selected={selected}
                aria-controls={panelId(i)}
                tabIndex={selected ? 0 : -1}
                onClick={() => onActiveChange(p.name)}
                onKeyDown={(e) => handleTabKeyDown(e, i)}
                className={`relative shrink-0 cursor-pointer whitespace-nowrap px-3 text-[12px] font-medium outline-none transition-colors duration-fast
                  focus-visible:bg-surface-light
                  ${selected ? "text-text" : "text-text-dim hover:text-text"}`}
              >
                {p.name}
                {selected && (
                  <span aria-hidden className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent" />
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {panels.map((p, i) => (
          <div
            key={p.name}
            role={showTabs ? "tabpanel" : undefined}
            id={showTabs ? panelId(i) : undefined}
            aria-labelledby={showTabs ? tabId(i) : undefined}
            className="absolute inset-0 overflow-y-auto"
            style={p.name === current ? undefined : { display: "none" }}
          >
            <PanelSlot
              variant="bare"
              name={p.name}
              html={p.html}
              sessionId={sessionId}
              panelData={panelData}
              onSendMessage={onSendMessage}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
