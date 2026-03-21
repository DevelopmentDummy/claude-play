/**
 * Autoplay & Steering Preset management.
 * Presets stored in localStorage.
 */

export interface SteeringPreset {
  id: string;
  name: string;
  instruction: string;
  createdAt: string;
}

const PRESETS_KEY = "autoplay-steering-presets";
const SELECTED_KEY = "autoplay-steering-selected";

export function loadPresets(): SteeringPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: SteeringPreset[]): void {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

export function addPreset(name: string, instruction: string): SteeringPreset {
  const presets = loadPresets();
  const preset: SteeringPreset = {
    id: crypto.randomUUID(),
    name,
    instruction,
    createdAt: new Date().toISOString(),
  };
  presets.push(preset);
  savePresets(presets);
  return preset;
}

export function updatePreset(id: string, updates: Partial<Pick<SteeringPreset, "name" | "instruction">>): void {
  const presets = loadPresets();
  const idx = presets.findIndex((p) => p.id === id);
  if (idx !== -1) {
    Object.assign(presets[idx], updates);
    savePresets(presets);
  }
}

export function deletePreset(id: string): void {
  const presets = loadPresets().filter((p) => p.id !== id);
  savePresets(presets);
  // Clear selection if deleted
  if (getSelectedPresetId() === id) {
    setSelectedPresetId(null);
  }
}

export function getSelectedPresetId(): string | null {
  return localStorage.getItem(SELECTED_KEY);
}

export function setSelectedPresetId(id: string | null): void {
  if (id) {
    localStorage.setItem(SELECTED_KEY, id);
  } else {
    localStorage.removeItem(SELECTED_KEY);
  }
}

export function getSelectedPreset(): SteeringPreset | null {
  const id = getSelectedPresetId();
  if (!id) return null;
  return loadPresets().find((p) => p.id === id) || null;
}

const DEFAULT_AUTO_PROMPT = `[사용자의 입력 없이 다음 턴을 진행하십시오. 사용자가 무반응을 한 상황에서 진행하는 것이 아니라 사용자의 응답을 당신 스스로 생성하는 것입니다. 전체 월드의 제어권을 당신에게 완전히 이양합니다.]`;

export function buildAutoplayMessage(preset: SteeringPreset | null): string {
  if (!preset || !preset.instruction.trim()) {
    return DEFAULT_AUTO_PROMPT;
  }
  return `${DEFAULT_AUTO_PROMPT}\n[사용자가 아래의 방향으로 전개되기를 원합니다.]\n${preset.instruction}`;
}

/**
 * Calculate delay (ms) based on response text length.
 * Scales from 3s (short) to 15s (long), ~1s per 200 chars.
 */
export function calculateAutoplayDelay(textLength: number): number {
  const seconds = Math.max(3, Math.min(15, textLength / 200));
  return seconds * 1000;
}
