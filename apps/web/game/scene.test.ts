import { describe, expect, it } from "vitest";
import type { Character, Floor, OfficeEvent } from "@ai-office/protocol";
import { OfficeState } from "./office-state";
import { buildRuntimeLayout } from "./layout-runtime";
import { Scene } from "./scene";
import { REAL_SHAPE_CHARACTERS, REAL_SHAPE_FLOOR } from "./fixtures/real-layout-fixture";

const TILE_SIZE = REAL_SHAPE_FLOOR.grid.tileSize;

/**
 * dept-tiny（内部タイル 1 枠のみ）+ dept-secretary（受付・フォールバック先）だけを
 * 持つ最小フロア。満室フォールバックを安価に再現するための専用 fixture。
 */
const SMALL_ROOM_FLOOR: Floor = {
  org: "small-org",
  label: "Small Org",
  grid: { cols: 20, rows: 14, tileSize: 32 },
  rooms: [
    { id: "dept-tiny", name: "Tiny", status: "active", x: 1, y: 1, w: 3, h: 3, triggers: [], door: { x: 2, y: 3 } },
    {
      id: "dept-secretary",
      name: "Secretary",
      status: "active",
      x: 10,
      y: 8,
      w: 5,
      h: 5,
      triggers: [],
      door: { x: 12, y: 12 },
    },
  ],
  furniture: [],
};

/**
 * 親セッション自身を roster claim させ、無帰属 visitor として受付タイルを
 * 消費させないための最小 roster（満室フォールバックのテストの意図を保つため）。
 */
const SMALL_ROOM_CHARACTERS: Character[] = [
  { id: "small-org:worker-1", name: "Worker 1", role: "worker-1", dept: "dept-tiny", org: "small-org" },
  { id: "small-org:worker-2", name: "Worker 2", role: "worker-2", dept: "dept-tiny", org: "small-org" },
];

function ev(partial: Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">): OfficeEvent {
  return partial;
}

function buildScene(fastMode: boolean): { scene: Scene; officeState: OfficeState } {
  const runtimeLayout = buildRuntimeLayout({ version: 1, floors: [REAL_SHAPE_FLOOR] }, REAL_SHAPE_CHARACTERS);
  const officeState = new OfficeState();
  const scene = new Scene(runtimeLayout, REAL_SHAPE_CHARACTERS, officeState, { fastMode });
  return { scene, officeState };
}

function advanceMany(scene: Scene, upTo: number): void {
  for (let tick = 0; tick <= upTo; tick += 1) {
    scene.advance(tick);
  }
}

describe("Scene: roster (AC-4)", () => {
  it("keeps all roster characters idle at their own desk before any session exists", () => {
    const { scene } = buildScene(false);
    const characters = scene.getRuntimeCharacters();

    expect(characters).toHaveLength(3);
    const secretary = characters.find((c) => c.id === "domain-tech-collection:secretary")!;
    expect(secretary).toMatchObject({ state: "idle", sessionId: null, x: 13, y: 10 });
    const researcher = characters.find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher).toMatchObject({ state: "idle", sessionId: null, x: 2, y: 4 });
    const retail = characters.find((c) => c.id === "domain-tech-collection:retail-domain-researcher")!;
    expect(retail).toMatchObject({ state: "idle", sessionId: null, x: 8, y: 4 });
  });

  it("claims the matching roster character by role+dept+org and shows the tool state at their own desk (no walking)", () => {
    const { scene, officeState } = buildScene(false);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Edit", ts: 1100, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );

    const researcher = scene.getRuntimeCharacters().find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher).toMatchObject({ state: "type", sessionId: "sess-1", toolName: "Edit", x: 2, y: 4 });
    // roster は claim されても常駐位置 (自席) から動かない
    expect(scene.getRuntimeCharacters()).toHaveLength(3);
  });

  it("a second session claiming the same role becomes a visitor instead of stealing the claim", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-2", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );

    const researcher = scene.getRuntimeCharacters().find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher.sessionId).toBe("sess-1");

    const visitor = scene.getRuntimeCharacters().find((c) => c.sessionId === "sess-2")!;
    expect(visitor).toBeDefined();
    expect(visitor.kind).toBe("visitor");
  });
});

describe("Scene: visitor + leave (AC-5)", () => {
  it("spawns an unattributed session as a visitor walking from the entrance toward reception", () => {
    const { scene, officeState } = buildScene(false);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));

    const visitor = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-1")!;
    expect(visitor.kind).toBe("visitor");
    expect(visitor.state).toBe("walk");
    // 入口 (フロア最下段中央) からスタートする
    expect(visitor.x).toBe(15);
    expect(visitor.y).toBe(13);
  });

  it("a visitor arrives at reception and reflects the session's tool state once the walk completes", () => {
    const { scene, officeState } = buildScene(false);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(ev({ type: "pre_tool", sessionId: "visitor-1", toolName: "Bash", ts: 1100, org: "domain-tech-collection" }));

    advanceMany(scene, 40);

    const visitor = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-1")!;
    expect(visitor.state).toBe("terminal");
    expect(visitor.path).toBeNull();
    // dept-secretary の内部アンカー (x=14, y=10) へ到着している
    expect(visitor).toMatchObject({ x: 14, y: 10 });
  });

  it("does not leave a duplicate ghost visitor when late-arriving attribution turns a visitor into a claim", () => {
    // 帰属推定が最初のイベントには無く、後続イベントで初めて role/dept/org が
    // 解決するケース（relay の attributor がブランチ名等から遅れて解決する想定）。
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "sess-1", ts: 1000 }));
    expect(scene.getRuntimeCharacters().filter((c) => c.sessionId === "sess-1")).toHaveLength(1);
    expect(scene.getRuntimeCharacters().find((c) => c.sessionId === "sess-1")!.kind).toBe("visitor");

    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Edit", ts: 1100, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );

    // sess-1 を名乗るキャラは claim された roster の 1 体だけであるべき（亡霊 visitor が残らない）
    const matches = scene.getRuntimeCharacters().filter((c) => c.sessionId === "sess-1");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ kind: "roster", id: "domain-tech-collection:tech-researcher", state: "type" });
  });

  it("session_end sends the visitor back to the entrance and despawns them (fast-mode teleports immediately)", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));
    expect(scene.getRuntimeCharacters().some((c) => c.sessionId === "visitor-1")).toBe(true);

    officeState.applyEvent(ev({ type: "session_end", sessionId: "visitor-1", ts: 2000 }));

    expect(scene.getRuntimeCharacters().some((c) => c.sessionId === "visitor-1")).toBe(false);
  });

  it("session_end on a claimed roster session returns them to idle at their own desk instantly (no walk)", () => {
    const { scene, officeState } = buildScene(false);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Edit", ts: 1100, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(ev({ type: "session_end", sessionId: "sess-1", ts: 2000 }));

    const researcher = scene.getRuntimeCharacters().find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher).toMatchObject({ state: "idle", sessionId: null, x: 2, y: 4 });
    expect(researcher.state).not.toBe("leave");
  });
});

describe("Scene: tick-driven walking", () => {
  it("does not move a walking character until advance() has been called at least twice (baseline + delta)", () => {
    const { scene, officeState } = buildScene(false);
    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));

    const before = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-1")!;
    const startX = before.x;
    const startY = before.y;

    scene.advance(0); // baseline のみ、まだ移動しない
    const after = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-1")!;
    expect(after.x).toBe(startX);
    expect(after.y).toBe(startY);
  });

  it("isIdle() is false while a character is walking and becomes true once every path is consumed", () => {
    const { scene, officeState } = buildScene(false);
    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));

    expect(scene.isIdle()).toBe(false);
    advanceMany(scene, 40);
    expect(scene.isIdle()).toBe(true);
  });

  it("exposes the last tick passed to advance() as the clock", () => {
    const { scene } = buildScene(false);
    scene.advance(7);
    expect(scene.getClock()).toBe(7);
  });
});

describe("Scene: subagent spawn/despawn (M1-4b AC-2)", () => {
  it("spawns a child 'sub' character for a Task-spawned subagent and routes it to the subagent's OWN dept room (not the parent's)", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({
        type: "pre_tool",
        sessionId: "sess-1",
        toolName: "Task",
        subagentType: "retail-helper",
        ts: 1100,
        org: "domain-tech-collection",
        dept: "dept-retail-domain",
        role: "retail-domain-researcher",
      }),
    );

    const sub = scene.getRuntimeCharacters().find((c) => c.kind === "sub")!;
    expect(sub).toBeDefined();
    // 到着後は固定で type 状態（子の個別ツールイベントは存在しないため）
    expect(sub).toMatchObject({ id: "sess-1:0", sessionId: "sess-1", dept: "dept-retail-domain", state: "type", x: 9, y: 4 });
    // 親（roster claim）は subagent の帰属に巻き込まれず dept-research のまま
    const researcher = scene.getRuntimeCharacters().find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher).toMatchObject({ sessionId: "sess-1", dept: "dept-research" });
  });

  it("routes an unattributed Task subagent to reception (fallback when the subagent has no dept)", () => {
    const { scene, officeState } = buildScene(true);

    // 親セッション自身は roster claim させて自席にとどめる（親が無帰属だと親自身も
    // 受付へ向かう visitor になり、受付アンカーの奪い合いでテストの意図がぼやけるため）。
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1100, org: "domain-tech-collection" }),
    );

    const sub = scene.getRuntimeCharacters().find((c) => c.kind === "sub")!;
    expect(sub).toMatchObject({ x: 14, y: 10 }); // dept-secretary の内部アンカー
  });

  it("subagent_stop despawns the sub character (fast-mode teleports out immediately)", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1100, org: "domain-tech-collection", dept: "dept-research" }),
    );
    expect(scene.getRuntimeCharacters().some((c) => c.kind === "sub")).toBe(true);

    officeState.applyEvent(ev({ type: "subagent_stop", sessionId: "sess-1", ts: 1200 }));

    expect(scene.getRuntimeCharacters().some((c) => c.kind === "sub")).toBe(false);
  });

  it("supports multiple concurrent subagents per session, spawning and despawning in LIFO order (known constraint: not exact-task-matched, but count-accurate)", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1100, org: "domain-tech-collection", dept: "dept-research" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "b", ts: 1200, org: "domain-tech-collection", dept: "dept-retail-domain" }),
    );

    const subs = scene.getRuntimeCharacters().filter((c) => c.kind === "sub");
    expect(subs).toHaveLength(2);
    expect(subs.map((c) => c.dept).sort()).toEqual(["dept-research", "dept-retail-domain"]);

    officeState.applyEvent(ev({ type: "subagent_stop", sessionId: "sess-1", ts: 1300 }));

    const remaining = scene.getRuntimeCharacters().filter((c) => c.kind === "sub");
    expect(remaining).toHaveLength(1);
    // LIFO: 最後に push された b（dept-retail-domain）が先に despawn する
    expect(remaining[0].dept).toBe("dept-research");
  });

  it("despawns all subs belonging to a session once the parent disappears from the snapshot (session_end) — no residual (fast-mode)", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1100, org: "domain-tech-collection", dept: "dept-research" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "b", ts: 1200, org: "domain-tech-collection", dept: "dept-retail-domain" }),
    );
    expect(scene.getRuntimeCharacters().filter((c) => c.kind === "sub")).toHaveLength(2);

    officeState.applyEvent(ev({ type: "session_end", sessionId: "sess-1", ts: 2000 }));

    expect(scene.getRuntimeCharacters().filter((c) => c.kind === "sub")).toHaveLength(0);
  });

  it("despawns subs after walking out once the parent session ends (slow mode) — zero residual after settling", () => {
    const { scene, officeState } = buildScene(false);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1100, org: "domain-tech-collection", dept: "dept-research" }),
    );
    officeState.applyEvent(ev({ type: "session_end", sessionId: "sess-1", ts: 2000 }));

    advanceMany(scene, 60);

    expect(scene.getRuntimeCharacters().filter((c) => c.kind === "sub")).toHaveLength(0);
  });
});

describe("Scene: non-overlapping tile allocation for visitor/sub (M1-4b AC-2)", () => {
  it("assigns distinct, non-overlapping tiles to multiple visitors arriving at reception (anchor first, then row-major)", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-2", ts: 1100, org: "domain-tech-collection" }));
    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-3", ts: 1200, org: "domain-tech-collection" }));

    const visitors = scene.getRuntimeCharacters().filter((c) => c.kind === "visitor");
    const tiles = visitors.map((v) => `${v.x},${v.y}`);
    expect(new Set(tiles).size).toBe(3); // 重複なし

    expect(visitors.find((v) => v.sessionId === "visitor-1")).toMatchObject({ x: 14, y: 10 }); // 内部アンカー
    expect(visitors.find((v) => v.sessionId === "visitor-2")).toMatchObject({ x: 13, y: 9 }); // 次の row-major タイル
    expect(visitors.find((v) => v.sessionId === "visitor-3")).toMatchObject({ x: 14, y: 9 });
  });

  it("is deterministic across repeated runs for the same event sequence (multiple visitors + subs)", () => {
    const events: Array<Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">> = [
      { type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" },
      { type: "session_start", sessionId: "sess-1", ts: 1100, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" },
      { type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1200, org: "domain-tech-collection", dept: "dept-retail-domain" },
      { type: "session_start", sessionId: "visitor-2", ts: 1300, org: "domain-tech-collection" },
    ];

    function run(): unknown {
      const { scene, officeState } = buildScene(true);
      for (const raw of events) officeState.applyEvent(ev(raw));
      return scene.getRuntimeCharacters().map((c) => ({ id: c.id, kind: c.kind, x: c.x, y: c.y, dept: c.dept }));
    }

    expect(run()).toEqual(run());
  });

  it("releases a visitor's reserved tile on departure so a later arrival can reuse it", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(ev({ type: "session_end", sessionId: "visitor-1", ts: 1100 }));
    expect(scene.getRuntimeCharacters().some((c) => c.sessionId === "visitor-1")).toBe(false);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-2", ts: 1200, org: "domain-tech-collection" }));
    const visitor2 = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-2")!;
    expect(visitor2).toMatchObject({ x: 14, y: 10 }); // アンカータイルが再利用される
  });

  it("falls back to reception once the target dept room is full (deterministic overflow)", () => {
    const runtimeLayout = buildRuntimeLayout({ version: 1, floors: [SMALL_ROOM_FLOOR] }, SMALL_ROOM_CHARACTERS);
    const officeState = new OfficeState();
    const scene = new Scene(runtimeLayout, SMALL_ROOM_CHARACTERS, officeState, { fastMode: true });

    // 親セッションは roster claim させる（無帰属だと親自身も visitor として受付タイルを
    // 消費してしまい、「dept-tiny 満室 → 受付フォールバック」の検証がぼやけるため）。
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "small-org", dept: "dept-tiny", role: "worker-1" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1100, org: "small-org", dept: "dept-tiny" }),
    );
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-2", ts: 1200, org: "small-org", dept: "dept-tiny", role: "worker-2" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-2", toolName: "Task", subagentType: "b", ts: 1300, org: "small-org", dept: "dept-tiny" }),
    );

    const subs = scene.getRuntimeCharacters().filter((c) => c.kind === "sub");
    expect(subs).toHaveLength(2);
    const first = subs.find((s) => s.sessionId === "sess-1")!;
    const second = subs.find((s) => s.sessionId === "sess-2")!;

    // dept-tiny の内部タイルは 1 枠のみ: 1 人目はそこへ、2 人目は満室のため受付
    // (dept-secretary) のアンカーへフォールバックする（dept 自体は subagent 自身の
    // 帰属のまま変わらない）。
    expect(first).toMatchObject({ dept: "dept-tiny", x: 2, y: 2 });
    expect(second).toMatchObject({ dept: "dept-tiny", x: 12, y: 10 });
  });
});

describe("Scene: subagent respawn before leave completes (office-qa M1-4b finding 1, slow-mode)", () => {
  it("keeps the leaving sub reachable and releases its tile when a same-session Task respawns before the leave walk finishes", () => {
    const runtimeLayout = buildRuntimeLayout({ version: 1, floors: [SMALL_ROOM_FLOOR] }, SMALL_ROOM_CHARACTERS);
    const officeState = new OfficeState();
    const scene = new Scene(runtimeLayout, SMALL_ROOM_CHARACTERS, officeState, { fastMode: false });

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "small-org", dept: "dept-tiny", role: "worker-1" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1100, org: "small-org", dept: "dept-tiny" }),
    );

    // subagent_stop より前に、退場歩行が非自明な経路になるよう sub_A を
    // dept-tiny のアンカーへ実際に到着させておく（entrance で足踏みしたままだと
    // 退場の目的地=現在地になり経路が即完了してしまい、このバグの再現条件を
    // 満たさない）。
    advanceMany(scene, 200);
    const settledBeforeStop = scene.getRuntimeCharacters().find((c) => c.kind === "sub")!;
    expect(settledBeforeStop).toMatchObject({ dept: "dept-tiny", x: 2, y: 2, state: "type", path: null });

    // Task → SubagentStop → Task を、退場歩行の完了前（tick を進めずに）連続適用
    // する（SSE restore バーストの典型パターン）。
    officeState.applyEvent(ev({ type: "subagent_stop", sessionId: "sess-1", ts: 1200 }));
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "b", ts: 1300, org: "small-org", dept: "dept-tiny" }),
    );

    // 退場中の sub_A（歩行中でまだ despawn していない）と新規 spawn の sub_B の
    // 両方が getRuntimeCharacters() に載っているべき。key が再利用されると
    // sub_A が subsByKey から上書きされ、1 体しか見えなくなる（孤児化）。
    const subsRightAfterRespawn = scene.getRuntimeCharacters().filter((c) => c.kind === "sub");
    expect(subsRightAfterRespawn).toHaveLength(2);

    // sub_A の退場歩行・sub_B の入場歩行の両方が完了するまで十分に進める。
    advanceMany(scene, 500);

    // 孤児化せず正しく removeCharacter を経由していれば、dept-tiny のタイルが
    // 解放され、別セッションの後続 Task がアンカーへ入れる。孤児のままタイルが
    // リークしていれば、ここでも満室と判定され受付へフォールバックしてしまう。
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-2", ts: 4000, org: "small-org", dept: "dept-tiny", role: "worker-2" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-2", toolName: "Task", subagentType: "c", ts: 4100, org: "small-org", dept: "dept-tiny" }),
    );
    advanceMany(scene, 800);

    const subC = scene.getRuntimeCharacters().find((c) => c.kind === "sub" && c.sessionId === "sess-2")!;
    expect(subC).toMatchObject({ dept: "dept-tiny", x: 2, y: 2, path: null });
  });
});

describe("Scene: focusSessionId (M1-4b AC-4)", () => {
  it("holds and clears the focused sessionId", () => {
    const { scene } = buildScene(false);
    expect(scene.getFocusedSessionId()).toBeNull();

    scene.focusSessionId("sess-1");
    expect(scene.getFocusedSessionId()).toBe("sess-1");

    scene.focusSessionId(null);
    expect(scene.getFocusedSessionId()).toBeNull();
  });

  it("a claimed roster RuntimeCharacter carries the same sessionId that focusSessionId records (renderer matches on this)", () => {
    const { scene, officeState } = buildScene(false);
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );

    scene.focusSessionId("sess-1");

    const researcher = scene.getRuntimeCharacters().find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher.sessionId).toBe(scene.getFocusedSessionId());
  });
});

describe("Scene: setPointer hit test + hoveredCharacter (M1-4b AC-6)", () => {
  it("resolves the roster character under the pointer, including model (claimed roster only)", () => {
    const { scene, officeState } = buildScene(false);
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Edit", ts: 1100, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );

    // researcher の自席は (2,4)
    scene.setPointer(2 * TILE_SIZE + 5, 4 * TILE_SIZE + 5);

    expect(scene.getHoveredCharacter()).toMatchObject({
      role: "tech-researcher",
      dept: "dept-research",
      sessionId: "sess-1",
      state: "type",
      toolName: "Edit",
      model: "sonnet",
    });
  });

  it("resolves nothing when the pointer is outside any character's tile", () => {
    const { scene } = buildScene(false);
    scene.setPointer(0, 0); // 誰もいない廊下タイル
    expect(scene.getHoveredCharacter()).toBeNull();
  });

  it("setPointer(null, null) clears the hovered character (mouseleave)", () => {
    const { scene } = buildScene(false);
    scene.setPointer(2 * TILE_SIZE + 5, 4 * TILE_SIZE + 5);
    expect(scene.getHoveredCharacter()).not.toBeNull();

    scene.setPointer(null, null);
    expect(scene.getHoveredCharacter()).toBeNull();
  });

  it("a tile's hit box is inclusive of its origin and exclusive of the next tile's origin (boundary)", () => {
    const { scene } = buildScene(false);
    // researcher の自席 (2,4) のタイル範囲は x:[64,96) y:[128,160)
    scene.setPointer(2 * TILE_SIZE, 4 * TILE_SIZE); // 左上隅ちょうど: ヒットする
    expect(scene.getHoveredCharacter()?.role).toBe("tech-researcher");

    scene.setPointer(3 * TILE_SIZE, 4 * TILE_SIZE); // 隣タイルの開始点: ヒットしない
    expect(scene.getHoveredCharacter()).toBeNull();
  });

  it("omits model for visitor/sub hover details (unknown — the one documented deviation from the README spec)", () => {
    const { scene, officeState } = buildScene(true);
    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-1", ts: 1000, org: "domain-tech-collection" }));

    const visitor = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-1")!;
    scene.setPointer(visitor.x * TILE_SIZE + 5, visitor.y * TILE_SIZE + 5);

    const hovered = scene.getHoveredCharacter();
    expect(hovered).toMatchObject({ kind: "visitor", sessionId: "visitor-1" });
    expect(hovered?.model).toBeUndefined();
  });

  it("elapsedTicks reflects ticks elapsed since the last office-event-driven update to that character", () => {
    const { scene, officeState } = buildScene(false);
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );

    scene.advance(0);
    scene.advance(20);
    scene.setPointer(2 * TILE_SIZE + 5, 4 * TILE_SIZE + 5);

    expect(scene.getHoveredCharacter()?.elapsedTicks).toBe(20);
  });
});

describe("Scene: requestText propagation (ADR-007 (b)-2 AC-1/AC-2/AC-3/AC-6)", () => {
  it("AC-1a: reflects requestText on the claimed roster character (claim path)", () => {
    const { scene, officeState } = buildScene(false);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({
        type: "pre_tool",
        sessionId: "sess-1",
        toolName: "Edit",
        ts: 1100,
        org: "domain-tech-collection",
        dept: "dept-research",
        role: "tech-researcher",
        requestText: "設計書を更新して",
      }),
    );

    const researcher = scene.getRuntimeCharacters().find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher.requestText).toBe("設計書を更新して");
  });

  it("AC-1b: reflects requestText on a freshly-spawned visitor (new-generation branch of applyVisitor)", () => {
    const { scene, officeState } = buildScene(true);

    // このセッションの最初のイベント自体に requestText が乗っている
    // （applyVisitor の新規生成分岐を通る唯一の機会）。
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "visitor-1", toolName: "Bash", ts: 1000, org: "domain-tech-collection", requestText: "調査して" }),
    );

    const visitor = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-1")!;
    expect(visitor.kind).toBe("visitor");
    expect(visitor.requestText).toBe("調査して");
  });

  it("AC-1c: reflects requestText that arrives after a visitor already exists (既存更新分岐)", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(ev({ type: "session_start", sessionId: "visitor-2", ts: 1000, org: "domain-tech-collection" }));
    const before = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-2")!;
    expect(before.requestText).toBeUndefined();

    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "visitor-2", toolName: "Bash", ts: 1100, org: "domain-tech-collection", requestText: "後で来た依頼" }),
    );

    const after = scene.getRuntimeCharacters().find((c) => c.sessionId === "visitor-2")!;
    expect(after.requestText).toBe("後で来た依頼");
  });

  it("AC-2: clears requestText when the session disappears from the snapshot (releaseClaim)", () => {
    const { scene, officeState } = buildScene(false);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({
        type: "pre_tool",
        sessionId: "sess-1",
        toolName: "Edit",
        ts: 1100,
        org: "domain-tech-collection",
        dept: "dept-research",
        role: "tech-researcher",
        requestText: "設計書を更新して",
      }),
    );
    officeState.applyEvent(ev({ type: "session_end", sessionId: "sess-1", ts: 2000 }));

    const researcher = scene.getRuntimeCharacters().find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher.requestText).toBeUndefined();
  });

  it("AC-3: HoveredCharacterDetail.requestText reflects the hit character's requestText", () => {
    const { scene, officeState } = buildScene(false);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({
        type: "pre_tool",
        sessionId: "sess-1",
        toolName: "Edit",
        ts: 1100,
        org: "domain-tech-collection",
        dept: "dept-research",
        role: "tech-researcher",
        requestText: "設計書を更新して",
      }),
    );

    scene.setPointer(2 * TILE_SIZE + 5, 4 * TILE_SIZE + 5);

    expect(scene.getHoveredCharacter()?.requestText).toBe("設計書を更新して");
  });

  it("AC-6: leaves the sub character's requestText undefined even though the parent session carries one (session-level scoping)", () => {
    const { scene, officeState } = buildScene(true);

    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    officeState.applyEvent(
      ev({
        type: "pre_tool",
        sessionId: "sess-1",
        toolName: "Task",
        subagentType: "retail-helper",
        ts: 1100,
        org: "domain-tech-collection",
        dept: "dept-retail-domain",
        role: "retail-domain-researcher",
        requestText: "小売ドメインを調べて",
      }),
    );

    const sub = scene.getRuntimeCharacters().find((c) => c.kind === "sub")!;
    expect(sub.requestText).toBeUndefined();

    // 対照: 親（claim 済み roster）は session 単位の requestText を保持している
    const researcher = scene.getRuntimeCharacters().find((c) => c.id === "domain-tech-collection:tech-researcher")!;
    expect(researcher.requestText).toBe("小売ドメインを調べて");
  });
});

describe("Scene: fast-mode determinism (AC-7)", () => {
  it("produces the same final character list for the same event sequence run twice", () => {
    const events: Array<Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">> = [
      { type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" },
      { type: "pre_tool", sessionId: "sess-1", toolName: "Edit", ts: 1100, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" },
      { type: "session_start", sessionId: "visitor-1", ts: 1200, org: "domain-tech-collection" },
      { type: "pre_tool", sessionId: "visitor-1", toolName: "Bash", ts: 1300, org: "domain-tech-collection" },
      { type: "session_end", sessionId: "visitor-1", ts: 1400 },
    ];

    function run(): unknown {
      const { scene, officeState } = buildScene(true);
      for (const raw of events) {
        officeState.applyEvent(ev(raw));
      }
      return scene.getRuntimeCharacters();
    }

    expect(run()).toEqual(run());
  });
});
