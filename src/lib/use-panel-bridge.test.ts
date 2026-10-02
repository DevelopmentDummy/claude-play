import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createLiveBridgeProxy, releaseBridgeSubs, RAW_SEND_KEY } from "./use-panel-bridge";

// 브라우저 window 대용 — createLiveBridgeProxy는 호출 시점에만 window.__panelBridge와 window 이벤트를 쓴다.
// globalThis.window를 바꿔 끼우므로 다른 테스트와 한 프로세스로 묶지 말 것 (`tsx --test`는 파일별 프로세스라 안전).
const win = new EventTarget() as EventTarget & Record<string, unknown>;
(globalThis as unknown as { window: unknown }).window = win;

function makeBridge(data: Record<string, unknown>) {
  return {
    data,
    on(event: string, handler: (detail?: unknown) => void) {
      const wrapped = (e: Event) => handler((e as CustomEvent).detail);
      win.addEventListener(`__bridge_evt:${event}`, wrapped);
      return () => win.removeEventListener(`__bridge_evt:${event}`, wrapped);
    },
  };
}

beforeEach(() => {
  delete win.__panelBridge;
});

test("조회 시점의 window.__panelBridge를 따른다 — data가 최신값", () => {
  win.__panelBridge = makeBridge({ n: 1 });
  const proxy = createLiveBridgeProxy();
  assert.deepEqual(proxy.data, { n: 1 });
  win.__panelBridge = makeBridge({ n: 2 });
  assert.deepEqual(proxy.data, { n: 2 });
});

test("on() 구독의 해제 함수가 수집된다", () => {
  win.__panelBridge = makeBridge({});
  const unsubs: Array<() => void> = [];
  const proxy = createLiveBridgeProxy((u) => unsubs.push(u));
  const got: unknown[] = [];
  const on = proxy.on as (e: string, h: (d?: unknown) => void) => () => void;
  on("stateChanged", (d) => got.push(d));
  assert.equal(unsubs.length, 1);
  win.dispatchEvent(new CustomEvent("__bridge_evt:stateChanged", { detail: 1 }));
  for (const u of unsubs) u();
  win.dispatchEvent(new CustomEvent("__bridge_evt:stateChanged", { detail: 2 }));
  assert.deepEqual(got, [1]);
});

test("브리지가 없어도 접근이 터지지 않고 on()은 window 이벤트로 동작한다", () => {
  const unsubs: Array<() => void> = [];
  const proxy = createLiveBridgeProxy((u) => unsubs.push(u));
  assert.equal(proxy.data, undefined);
  const got: unknown[] = [];
  const on = proxy.on as (e: string, h: (d?: unknown) => void) => () => void;
  on("panel:x", (d) => got.push(d));
  win.dispatchEvent(new CustomEvent("__bridge_evt:panel:x", { detail: "a" }));
  for (const u of unsubs) u();
  win.dispatchEvent(new CustomEvent("__bridge_evt:panel:x", { detail: "b" }));
  assert.deepEqual(got, ["a"]);
});

test("프록시가 window.__panelBridge에 되꽂혀도 무한 재귀하지 않는다", () => {
  const proxy = createLiveBridgeProxy();
  win.__panelBridge = proxy;
  assert.doesNotThrow(() => proxy.data);
  assert.doesNotThrow(() => "on" in proxy);
  assert.doesNotThrow(() => Object.keys(proxy));
  const other = createLiveBridgeProxy();
  assert.doesNotThrow(() => other.data);
});

test("rawSend 옵션이면 모달 래핑 전 원본 sendMessage를 돌려준다", () => {
  const sent: string[] = [];
  const raw = (t: string) => sent.push("raw:" + t);
  const bridge: Record<string, unknown> = { ...makeBridge({}), sendMessage: (t: string) => sent.push("wrapped:" + t) };
  Object.defineProperty(bridge, RAW_SEND_KEY, { value: raw, enumerable: false, configurable: true, writable: true });
  win.__panelBridge = bridge;
  (createLiveBridgeProxy(undefined, { rawSend: true }).sendMessage as (t: string) => void)("a");
  (createLiveBridgeProxy().sendMessage as (t: string) => void)("b");
  assert.deepEqual(sent, ["raw:a", "wrapped:b"]);
  // 원본이 없으면 rawSend여도 그냥 sendMessage
  win.__panelBridge = { ...makeBridge({}), sendMessage: (t: string) => sent.push("plain:" + t) };
  (createLiveBridgeProxy(undefined, { rawSend: true }).sendMessage as (t: string) => void)("c");
  assert.equal(sent[2], "plain:c");
});

test("프록시를 프로토타입·대상으로 둔 래퍼가 window에 꽂혀도 무한 재귀하지 않는다", () => {
  win.__panelBridge = makeBridge({ n: 1 });
  const proxy = createLiveBridgeProxy();
  win.__panelBridge = Object.create(proxy);
  assert.doesNotThrow(() => proxy.data);
  win.__panelBridge = new Proxy(proxy, {});
  assert.doesNotThrow(() => proxy.data);
  assert.doesNotThrow(() => "data" in proxy);
});

test("releaseBridgeSubs는 모든 해제 함수를 부르고 배열을 비운다", () => {
  const calls: number[] = [];
  const subs = [() => calls.push(1), () => { throw new Error("x"); }, () => calls.push(3)];
  releaseBridgeSubs(subs);
  assert.deepEqual(calls, [1, 3]);
  assert.equal(subs.length, 0);
});
