import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { OfficeState } from "./office-state";
import { buildRuntimeLayout } from "./layout-runtime";
import { Scene } from "./scene";
import { attachDebug, buildDebugState, waitForSceneIdle } from "./debug";
import { REAL_SHAPE_CHARACTERS, REAL_SHAPE_FLOOR } from "./fixtures/real-layout-fixture";

function ev(partial: Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">): OfficeEvent {
  return partial;
}

function buildScene(fastMode: boolean) {
  const runtimeLayout = buildRuntimeLayout({ version: 1, floors: [REAL_SHAPE_FLOOR] }, REAL_SHAPE_CHARACTERS);
  const officeState = new OfficeState();
  const scene = new Scene(runtimeLayout, REAL_SHAPE_CHARACTERS, officeState, { fastMode });
  return { scene, officeState, runtimeLayout };
}

describe("buildDebugState", () => {
  it("matches the shape from loop-engineering-design.md §5.1 (characters/floors/pendingNotifications/clock)", () => {
    const { scene, runtimeLayout } = buildScene(false);
    const state = buildDebugState(scene, runtimeLayout);

    expect(Object.keys(state).sort()).toEqual(["characters", "clock", "floors", "pendingNotifications"]);
    expect(Array.isArray(state.characters)).toBe(true);
    expect(Array.isArray(state.floors)).toBe(true);
    expect(typeof state.pendingNotifications).toBe("number");
    expect(typeof state.clock).toBe("number");

    const character = state.characters[0];
    expect(Object.keys(character).sort()).toEqual(["dept", "id", "role", "sessionId", "state", "x", "y"]);

    const floor = state.floors[0];
    expect(Object.keys(floor).sort()).toEqual(["org", "rooms"]);
    expect(floor.org).toBe("domain-tech-collection");
    expect(floor.rooms).toEqual(["dept-research", "dept-retail-domain", "dept-secretary"]);
  });

  it("reports idle roster characters with sessionId null and their own role/dept", () => {
    const { scene, runtimeLayout } = buildScene(false);
    const state = buildDebugState(scene, runtimeLayout);

    const researcher = state.characters.find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher).toMatchObject({
      role: "tech-researcher",
      dept: "dept-research",
      state: "idle",
      sessionId: null,
      x: 2,
      y: 4,
    });
  });

  it("counts characters currently in the waiting state as pendingNotifications", () => {
    const { scene, officeState, runtimeLayout } = buildScene(false);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({ type: "notification", sessionId: "sess-1", ts: 1100, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );

    const state = buildDebugState(scene, runtimeLayout);
    expect(state.pendingNotifications).toBe(1);
  });

  // M1-4b AC-5（設計メモ rev.2/rev.3 で明示的に認可された意味論変更。tests.md ルール 1）:
  // pendingNotifications のソースを「RuntimeCharacter.state === 'waiting' の件数」から
  // 「OfficeState スナップショットの waiting セッション数」（scene.getWaitingSessionCount()
  // 経由）へ一本化した。理由: 無帰属セッション（visitor）は受付へ向かって歩行している間
  // RuntimeCharacter.state が "walk"（onArriveState に "waiting" を保持したまま）に
  // なるため、旧実装（characters 側の state を数える）だと「セッションはすでに
  // waiting なのに、歩行が終わるまでバッジ・待ちパネル・pendingNotifications が
  // それを反映しない」歩行遅延による乖離が起きていた。この test はその乖離を red で
  // 再現してから、ソース一本化で green にする（buildDebugState のシグネチャは不変）。
  it("counts a session as pending even while its visitor character is still walking toward reception (no walk-delay drift — AC-5)", () => {
    const { scene, officeState, runtimeLayout } = buildScene(false); // slow mode: 歩行が即座には終わらない

    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(ev({ type: "notification", sessionId: "visitor-1", ts: 1100, org: "domain-tech-collection" }));

    // OfficeState 上のセッションはすでに waiting だが、visitor の RuntimeCharacter は
    // まだ受付へ向けて歩行中（state === "walk"）のはず。
    const visitor = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-1")!;
    expect(visitor.state).toBe("walk");

    const state = buildDebugState(scene, runtimeLayout);
    expect(state.pendingNotifications).toBe(1);
  });

  it("exposes scene.getClock() as clock", () => {
    const { scene, runtimeLayout } = buildScene(false);
    scene.advance(3);
    scene.advance(9);

    const state = buildDebugState(scene, runtimeLayout);
    expect(state.clock).toBe(9);
  });
});

describe("waitForSceneIdle", () => {
  it("resolves once the scene becomes idle, driven purely by an injected scheduler (no sleep/timers)", async () => {
    const { scene, officeState } = buildScene(false);
    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));
    expect(scene.isIdle()).toBe(false);

    const pending: Array<() => void> = [];
    const schedule = (cb: () => void) => {
      pending.push(cb);
    };

    const promise = waitForSceneIdle(scene, schedule);
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    // まだ歩行中: スケジューラを 1 回ドレインしても resolve しない
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(pending).toHaveLength(1);

    // tick を進めて歩行を完了させてから、次のポーリングをドレインする
    for (let tick = 0; tick <= 40; tick += 1) scene.advance(tick);
    const next = pending.shift()!;
    next();
    await Promise.resolve();

    expect(resolved).toBe(true);
  });

  it("resolves immediately when the scene is already idle", async () => {
    const { scene } = buildScene(false);
    expect(scene.isIdle()).toBe(true);

    const pending: Array<() => void> = [];
    const schedule = (cb: () => void) => pending.push(cb);

    let resolved = false;
    void waitForSceneIdle(scene, schedule).then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect(pending).toHaveLength(0);
  });
});

// typescript.md ルール 5: 「production で tree-shake されることを unit テストで検証する」。
// apps/web の vitest environment は "node"（jsdom 無し）のため、attachDebug 内の
// `typeof window === "undefined"` ガードへ実際に到達させるには、テスト側で
// globalThis.window を最小限のオブジェクトとして注入する必要がある（ブラウザに
// window があるという前提を満たすだけの最小スタブ。jsdom 全体は不要）。
describe("attachDebug: production ゲート", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { window?: unknown }).window;
  });

  it("NODE_ENV=production では window.__OFFICE_DEBUG__ を定義しない", () => {
    (globalThis as { window?: unknown }).window = {};
    vi.stubEnv("NODE_ENV", "production");

    const { scene, runtimeLayout } = buildScene(false);
    attachDebug(scene, runtimeLayout);

    expect(window.__OFFICE_DEBUG__).toBeUndefined();
  });

  it("NODE_ENV が production 以外では window.__OFFICE_DEBUG__ に getState/waitForIdle を定義する", () => {
    (globalThis as { window?: unknown }).window = {};
    vi.stubEnv("NODE_ENV", "test");

    const { scene, runtimeLayout } = buildScene(false);
    attachDebug(scene, runtimeLayout);

    expect(window.__OFFICE_DEBUG__).toBeDefined();
    expect(typeof window.__OFFICE_DEBUG__?.getState).toBe("function");
    expect(typeof window.__OFFICE_DEBUG__?.waitForIdle).toBe("function");

    // 取り付けた getState が実際に scene/runtimeLayout に紐づいていることも確認する
    // （単に関数が生えているだけでなく、buildDebugState と同じ結果を返す）。
    expect(window.__OFFICE_DEBUG__?.getState()).toEqual(buildDebugState(scene, runtimeLayout));
  });

  it("window が無い環境（typeof window === 'undefined'）では何もしない", () => {
    delete (globalThis as { window?: unknown }).window;
    vi.stubEnv("NODE_ENV", "test");

    const { scene, runtimeLayout } = buildScene(false);
    expect(() => attachDebug(scene, runtimeLayout)).not.toThrow();
  });
});
