import * as fs from "fs";
import * as path from "path";

type Dict = Record<string, unknown>;

/** layout.json -> panels.modalGroups. BOM 내성, 어떤 오류든 {} 반환. */
export function readModalGroups(sessionDir: string): Record<string, string[]> {
  const layoutPath = path.join(sessionDir, "layout.json");
  try {
    let raw = fs.readFileSync(layoutPath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const groups = JSON.parse(raw)?.panels?.modalGroups;
    return groups && typeof groups === "object" && !Array.isArray(groups) ? groups : {};
  } catch {
    return {};
  }
}

/** name을 포함하는 첫 그룹의 멤버 배열, 없으면 null. */
function findGroup(groups: Record<string, string[]>, name: string): string[] | null {
  for (const members of Object.values(groups)) {
    if (Array.isArray(members) && members.includes(name)) return members;
  }
  return null;
}

/**
 * 단일 모달 변경 + 그룹 자동닫기. 입력을 변형하지 않고 새 맵 반환.
 *  - value truthy: 같은 그룹 형제 false 처리 후 next[name] = value
 *  - value falsy : next[name] = false
 */
export function applyModalChange(
  modals: Dict,
  groups: Record<string, string[]>,
  name: string,
  value: unknown,
): Dict {
  const next: Dict = { ...modals };
  if (value) {
    const members = findGroup(groups, name);
    if (members) for (const m of members) if (m !== name) next[m] = false;
    next[name] = value;
  } else {
    next[name] = false;
  }
  return next;
}

/** except에 없는 모든 키를 false로. 새 맵 반환. */
export function closeAllModals(modals: Dict, except: string[] = []): Dict {
  const exceptSet = new Set(except);
  const next: Dict = { ...modals };
  for (const key of Object.keys(next)) if (!exceptSet.has(key)) next[key] = false;
  return next;
}
