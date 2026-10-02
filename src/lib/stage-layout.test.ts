import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_WIDTH_DEFAULT,
  CHAT_WIDTH_MIN,
  STAGE_MIN_WIDTH,
  chatWidthMax,
  clampChatWidth,
  fitStageSides,
  SIDEBAR_FIT_MIN,
  isResidentPlacement,
  normalizePanelKey,
  resolveFocusTarget,
  resolvePanelPlacement,
  resolveStage,
} from "./stage-layout";

test("normalizePanelKey는 숫자 prefix만 제거한다", () => {
  assert.equal(normalizePanelKey("01-원고"), "원고");
  assert.equal(normalizePanelKey("원고"), "원고");
  assert.equal(normalizePanelKey("2-a-b"), "a-b");
  assert.equal(normalizePanelKey("x-01"), "x-01");
});

test("main 배치가 없으면 무대 비활성 — 기존 페르소나 무영향", () => {
  const r = resolveStage({
    panelNames: ["상태", "프로필"],
    placement: { 상태: "right", 프로필: "left" },
    appModeActive: false,
  });
  assert.deepEqual(r, { active: false, mainPanelNames: [] });
  assert.deepEqual(resolveStage({ panelNames: [], placement: {}, appModeActive: false }), {
    active: false,
    mainPanelNames: [],
  });
});

test("main 패널은 파일 순서를 유지한다", () => {
  const r = resolveStage({
    panelNames: ["목차", "원고", "트리트먼트", "메모"],
    placement: { 트리트먼트: "main", 목차: "left", 원고: "main" },
    appModeActive: false,
  });
  assert.equal(r.active, true);
  assert.deepEqual(r.mainPanelNames, ["원고", "트리트먼트"]);
});

test("placement 키가 정규화돼 있으면 prefix 있는 패널 이름도 찾는다", () => {
  const r = resolveStage({
    panelNames: ["01-원고"],
    placement: { 원고: "main" },
    appModeActive: false,
  });
  assert.deepEqual(r.mainPanelNames, ["01-원고"]);
});

test("앱 모드면 main이 있어도 무대 비활성", () => {
  const r = resolveStage({
    panelNames: ["원고"],
    placement: { 원고: "main" },
    appModeActive: true,
  });
  assert.deepEqual(r, { active: false, mainPanelNames: [] });
});

test("clampChatWidth — 숫자가 아니면 기본값 기준", () => {
  assert.equal(clampChatWidth(undefined, 1920, 300), CHAT_WIDTH_DEFAULT);
  assert.equal(clampChatWidth(null, 1920, 300), CHAT_WIDTH_DEFAULT);
  assert.equal(clampChatWidth(Number.NaN, 1920, 300), CHAT_WIDTH_DEFAULT);
});

test("clampChatWidth — 하한은 CHAT_WIDTH_MIN", () => {
  assert.equal(clampChatWidth(100, 1920, 0), CHAT_WIDTH_MIN);
  assert.equal(clampChatWidth(-5, 1920, 0), CHAT_WIDTH_MIN);
});

test("clampChatWidth — 무대가 STAGE_MIN_WIDTH 이상 남도록 상한", () => {
  // 1440 - 300 - 480 = 660
  assert.equal(clampChatWidth(900, 1440, 300), 660);
  assert.equal(chatWidthMax(1440, 300), 660);
  assert.equal(clampChatWidth(500, 1440, 300), 500);
  // 남는 폭이 없어도 CHAT_WIDTH_MIN 아래로는 내려가지 않는다
  assert.equal(clampChatWidth(900, 800, 300), CHAT_WIDTH_MIN);
  assert.equal(chatWidthMax(800, 300), CHAT_WIDTH_MIN);
  assert.equal(clampChatWidth(undefined, 600, 0), CHAT_WIDTH_MIN);
  // 결과는 정수
  assert.equal(clampChatWidth(450.6, 1920, 0), 451);
  assert.ok(STAGE_MIN_WIDTH > 0);
});

test("resolvePanelPlacement — panels.placement 우선, 구형 최상위 placement 폴백, prefix 정규화", () => {
  const layout = {
    panels: { placement: { "01-원고": "main", 목차: "left" } },
    placement: { 원고: "modal", 상점: "modal-dismissible" },
  };
  assert.equal(resolvePanelPlacement(layout, "원고"), "main");
  assert.equal(resolvePanelPlacement(layout, "01-원고"), "main");
  assert.equal(resolvePanelPlacement(layout, "목차"), "left");
  assert.equal(resolvePanelPlacement(layout, "상점"), "modal-dismissible");
  assert.equal(resolvePanelPlacement(layout, "없음"), undefined);
  assert.equal(resolvePanelPlacement(null, "원고"), undefined);
  assert.equal(resolvePanelPlacement({ panels: { placement: "x" } }, "원고"), undefined);
});

test("isResidentPlacement — 사이드바·무대만 상주 배치", () => {
  for (const p of ["left", "right", "main"]) assert.equal(isResidentPlacement(p), true);
  for (const p of ["modal", "modal-dismissible", "full-screen", "dock", "dock-left", "dock-right", "dock-bottom", undefined]) {
    assert.equal(isResidentPlacement(p), false);
  }
});

test("resolveFocusTarget — main은 탭, modal 계열은 모달, 나머지는 무시", () => {
  const names = ["원고", "상점", "전투", "상태", "독"];
  const placement = {
    원고: "main",
    상점: "modal-dismissible",
    전투: "full-screen",
    상태: "right",
    독: "dock-bottom",
  };
  const main = ["원고"];
  assert.deepEqual(resolveFocusTarget("원고", names, placement, main), { kind: "tab", name: "원고" });
  assert.deepEqual(resolveFocusTarget("01-원고", names, placement, main), { kind: "tab", name: "원고" });
  assert.deepEqual(resolveFocusTarget("상점", names, placement, main), { kind: "modal", name: "상점" });
  assert.deepEqual(resolveFocusTarget("전투", names, placement, main), { kind: "modal", name: "전투" });
  assert.equal(resolveFocusTarget("상태", names, placement, main), null);
  assert.equal(resolveFocusTarget("독", names, placement, main), null);
  assert.equal(resolveFocusTarget("없는패널", names, placement, main), null);
  assert.equal(resolveFocusTarget("", names, placement, main), null);
  // 앱 모드처럼 무대가 꺼져 있으면 main 배치도 무시된다
  assert.equal(resolveFocusTarget("원고", names, placement, []), null);
});

test("fitStageSides: 여유가 있으면 사이드바 폭을 그대로 둔다", () => {
  assert.deepEqual(fitStageSides(1920, 340, 0, 420), { left: 340, right: 0 });
  assert.deepEqual(fitStageSides(1920, 300, 300, 420), { left: 300, right: 300 });
});

test("fitStageSides: 창이 좁으면 무대가 STAGE_MIN_WIDTH 남도록 비율대로 줄인다", () => {
  // 1366 - 320 - 480 = 566 → 380+380을 566으로
  const r = fitStageSides(1366, 380, 380, 320);
  assert.ok(r.left + r.right <= 566);
  assert.equal(r.left, r.right);
  assert.ok(1366 - 320 - r.left - r.right >= STAGE_MIN_WIDTH);
});

test("fitStageSides: 하한(SIDEBAR_FIT_MIN) 아래로는 먼저 줄이지 않는다", () => {
  // 1000 - 320 - 480 = 200 → 하한 합(400)보다 작다 → 각 200, 무대는 280으로 양보
  const r = fitStageSides(1000, 380, 380, 320);
  assert.deepEqual(r, { left: SIDEBAR_FIT_MIN, right: SIDEBAR_FIT_MIN });
  assert.ok(1000 - 320 - r.left - r.right >= 0);
});

test("fitStageSides: 극단적으로 좁아도 사이드바가 채팅 컬럼을 침범하지 않는다(무대 ≥ 0)", () => {
  const r = fitStageSides(700, 380, 380, 320);
  assert.ok(r.left + r.right <= 700 - 320);
  assert.ok(r.left >= 0 && r.right >= 0);
});

test("fitStageSides: 비정상 입력은 안전하게 처리한다", () => {
  assert.deepEqual(fitStageSides(1200, 0, 0, 420), { left: 0, right: 0 });
  assert.deepEqual(fitStageSides(Number.NaN, 300, 0, 420), { left: 300, right: 0 });
  assert.deepEqual(fitStageSides(1200, Number.NaN, -5, 420), { left: 0, right: 0 });
});
