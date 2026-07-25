import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { OfficeState } from "./office-state";
import { buildRuntimeLayout } from "./layout-runtime";
import { Scene } from "./scene";
import { REAL_SHAPE_CHARACTERS, REAL_SHAPE_FLOOR } from "./fixtures/real-layout-fixture";

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
