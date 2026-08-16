import { describe, expect, it } from "vitest";
import type { Character, OfficeEvent } from "@ai-office/protocol";
import type { SessionCharacter } from "../../game/office-state";
import { OfficeState } from "../../game/office-state";
import { buildRuntimeLayout } from "../../game/layout-runtime";
import { Scene } from "../../game/scene";
import { buildSessionListRows, buildWaitingRows, countWaiting } from "./session-list";

function session(partial: Partial<SessionCharacter> & Pick<SessionCharacter, "sessionId" | "state" | "lastTs">): SessionCharacter {
  return { activeSubagents: [], ...partial };
}

describe("buildSessionListRows (M1-4b: サイドバーのセッション一覧整形)", () => {
  it("sorts sessions by most-recently-updated first", () => {
    const rows = buildSessionListRows(
      [session({ sessionId: "old", state: "idle", lastTs: 1000 }), session({ sessionId: "new", state: "idle", lastTs: 5000 })],
      10_000,
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["new", "old"]);
  });

  it("shortens the sessionId and formats elapsed from the injected now", () => {
    const rows = buildSessionListRows([session({ sessionId: "session-1234567890", state: "type", lastTs: 1000 })], 1000 + 65_000);
    expect(rows[0].shortId).toBe("session-");
    expect(rows[0].elapsed).toBe("1:05");
  });

  it("falls back to an 不明 label for unattributed role/dept (attribution not yet resolved)", () => {
    const rows = buildSessionListRows([session({ sessionId: "s1", state: "idle", lastTs: 0 })], 0);
    expect(rows[0].role).toBe("不明");
    expect(rows[0].dept).toBe("不明");
  });

  it("passes through attributed role/dept/org/state as-is", () => {
    const rows = buildSessionListRows(
      [session({ sessionId: "s1", state: "waiting", lastTs: 0, role: "tech-researcher", dept: "dept-research", org: "org-a" })],
      0,
    );
    expect(rows[0]).toMatchObject({ role: "tech-researcher", dept: "dept-research", org: "org-a", state: "waiting" });
  });

  it("returns an empty list for no sessions", () => {
    expect(buildSessionListRows([], 0)).toEqual([]);
  });
});

describe("buildSessionListRows requestText (ADR-007 (b)-1 AC-9: 作業依頼の短縮表示)", () => {
  it("includes a truncated requestText when the session carries one", () => {
    const rows = buildSessionListRows([session({ sessionId: "s1", state: "type", lastTs: 0, requestText: "実装して" })], 0);
    expect(rows[0].requestText).toBe("実装して");
  });

  it("truncates a long requestText to the shared 40-char limit with an ellipsis", () => {
    const long = "a".repeat(50);
    const rows = buildSessionListRows([session({ sessionId: "s1", state: "type", lastTs: 0, requestText: long })], 0);
    expect(rows[0].requestText).toBe(`${"a".repeat(40)}…`);
  });

  it("leaves requestText undefined when the session has none", () => {
    const rows = buildSessionListRows([session({ sessionId: "s1", state: "idle", lastTs: 0 })], 0);
    expect(rows[0].requestText).toBeUndefined();
  });
});

describe("buildWaitingRows / countWaiting (M1-4b AC-5: 待ちパネル + バッジの一致)", () => {
  it("buildWaitingRows only includes state === waiting sessions", () => {
    const sessions = [
      session({ sessionId: "s1", state: "waiting", lastTs: 0 }),
      session({ sessionId: "s2", state: "type", lastTs: 0 }),
      session({ sessionId: "s3", state: "waiting", lastTs: 0 }),
    ];
    const rows = buildWaitingRows(sessions, 0);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["s1", "s3"]);
  });

  it("countWaiting matches the length of buildWaitingRows for the same input (badge count === panel list length)", () => {
    const sessions = [
      session({ sessionId: "s1", state: "waiting", lastTs: 0 }),
      session({ sessionId: "s2", state: "idle", lastTs: 0 }),
      session({ sessionId: "s3", state: "waiting", lastTs: 0 }),
      session({ sessionId: "s4", state: "done", lastTs: 0 }),
    ];
    expect(countWaiting(sessions)).toBe(buildWaitingRows(sessions, 0).length);
    expect(countWaiting(sessions)).toBe(2);
  });

  it("returns 0 / empty list when nobody is waiting", () => {
    const sessions = [session({ sessionId: "s1", state: "idle", lastTs: 0 })];
    expect(countWaiting(sessions)).toBe(0);
    expect(buildWaitingRows(sessions, 0)).toEqual([]);
  });
});

describe("AC-5: OfficeState の waiting セッション数が UI 側 (countWaiting) と scene 側 (getWaitingSessionCount) で一致する", () => {
  function ev(partial: Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">): OfficeEvent {
    return partial;
  }

  it("stays in sync across a sequence of notification / pre_tool events (single source of truth)", () => {
    const characters: Character[] = [{ id: "org:worker", name: "Worker", role: "worker", dept: "dept-work", org: "org" }];
    const runtimeLayout = buildRuntimeLayout(null, characters);
    const officeState = new OfficeState();
    const scene = new Scene(runtimeLayout, characters, officeState, { fastMode: true });

    officeState.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    officeState.applyEvent(ev({ type: "notification", sessionId: "s1", ts: 2000 }));
    officeState.applyEvent(ev({ type: "session_start", sessionId: "s2", ts: 3000 }));
    officeState.applyEvent(ev({ type: "notification", sessionId: "s2", ts: 4000 }));

    const waitingFromUi = countWaiting(officeState.getSnapshot().sessions);
    expect(waitingFromUi).toBe(2);
    expect(scene.getWaitingSessionCount()).toBe(waitingFromUi);

    officeState.applyEvent(ev({ type: "stop", sessionId: "s1", ts: 5000 }));
    const waitingAfterStop = countWaiting(officeState.getSnapshot().sessions);
    expect(waitingAfterStop).toBe(1);
    expect(scene.getWaitingSessionCount()).toBe(waitingAfterStop);
  });
});
