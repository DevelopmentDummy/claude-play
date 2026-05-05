/**
 * panel-actions-meta.ts
 *
 * 서버 사이드 패널 액션 메타 reader.
 * 세션 디렉토리의 `panels/_actions.meta.json`을 읽어 시스템 지시문 주입용
 * 마크다운으로 변환하거나, 단일 액션의 spec lookup에 사용한다.
 *
 * Source of truth는 사이드카 JSON. registerAction(클라이언트)과 별개로
 * 동작하므로, 핸들러가 실제로 등록되기 전에도 서버가 spec을 알 수 있다.
 */

import fs from "fs";
import path from "path";

export interface ActionSpec {
  label: string;
  required?: string[];
  values?: Record<string, string[]>;
  note?: string;
}

export interface PanelActionsMeta {
  panels: Record<string, Record<string, ActionSpec>>;
}

/**
 * 세션/페르소나 디렉토리에서 panels/_actions.meta.json을 읽는다.
 * 없거나 파싱 실패 시 null.
 */
export function readPanelActionsMeta(sessionDir: string): PanelActionsMeta | null {
  const metaPath = path.join(sessionDir, "panels", "_actions.meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.panels) return null;
    return parsed as PanelActionsMeta;
  } catch {
    return null;
  }
}

/**
 * 단일 액션의 spec을 반환. 없으면 null.
 * `[정의]` 이벤트 큐잉 시 사용.
 */
export function getActionSpec(
  meta: PanelActionsMeta | null,
  panel: string,
  action: string
): ActionSpec | null {
  if (!meta) return null;
  return meta.panels?.[panel]?.[action] ?? null;
}

/**
 * 단일 액션 spec을 한 줄 시그니처 문자열로 포맷.
 * 예: `베스라.besra_evening(필수: action ∈ {conversation,wine_session,...}) — 밤자리 시작. 야간 슬롯 완료 후...`
 */
export function formatSpecAsLine(panel: string, action: string, spec: ActionSpec): string {
  const required = spec.required ?? [];
  const reqParts: string[] = [];
  for (const param of required) {
    const values = spec.values?.[param];
    if (values && values.length > 0) {
      const enumStr = values.length <= 6
        ? values.join(",")
        : `${values.slice(0, 5).join(",")},...총 ${values.length}개`;
      reqParts.push(`${param} ∈ {${enumStr}}`);
    } else {
      reqParts.push(param);
    }
  }
  const sig = reqParts.length > 0 ? `필수: ${reqParts.join(", ")}` : "no-arg";
  const noteSuffix = spec.note ? ` — ${spec.note}` : "";
  return `${panel}.${action}(${sig}) [${spec.label}]${noteSuffix}`;
}

/**
 * 전체 메타를 시스템 지시문 주입용 마크다운으로 변환.
 * 패널별 그룹핑, 각 액션 한 줄. 시스템 지시문 끝에 한 번 박힌다.
 */
export function formatPanelActionsAsMarkdown(meta: PanelActionsMeta | null): string {
  if (!meta || !meta.panels) return "";
  const sections: string[] = [];
  sections.push("## 패널 액션 정의 (참조용)");
  sections.push("");
  sections.push("선택지의 `actions`에 박을 수 있는 패널 액션 목록과 *필수 파라미터*. `[AVAILABLE]` 헤더의 시그니처가 모호할 때 이 정의를 우선 참조하라. 잘못된 호출로 [액션 실패]가 발생하면 다음 턴에 [정의] 이벤트로 해당 액션의 spec이 리마인드된다.");
  sections.push("");

  for (const [panel, actions] of Object.entries(meta.panels)) {
    sections.push(`### ${panel}`);
    sections.push("");
    for (const [actionId, spec] of Object.entries(actions)) {
      sections.push(`- ${formatSpecAsLine(panel, actionId, spec)}`);
    }
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}
