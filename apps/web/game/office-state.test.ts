import { describe, expect, it, vi } from "vitest";
import { OfficeState } from "./office-state";
import type { OfficeEvent } from "@ai-office/protocol";

function ev(partial: Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">): OfficeEvent {
  return partial;
}

describe("OfficeState.applyEvent", () => {
  it("session_start creates a session in idle state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));

    const snapshot = state.getSnapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: "s1",
      state: "idle",
      lastTs: 1000,
    });
  });

  it("pre_tool with Edit maps to type state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ state: "type", toolName: "Edit", lastTs: 1100 });
  });

  it("pre_tool with Read maps to read state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Read", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.state).toBe("read");
  });

  it("post_tool moves to thinking state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1100 }));
    state.applyEvent(ev({ type: "post_tool", sessionId: "s1", toolName: "Edit", ts: 1200 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.state).toBe("thinking");
    expect(session?.lastTs).toBe(1200);
  });

  it("user_prompt moves to thinking state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "user_prompt", sessionId: "s1", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.state).toBe("thinking");
  });

  it("notification moves to waiting state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "notification", sessionId: "s1", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.state).toBe("waiting");
  });

  it("stop moves to done state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "stop", sessionId: "s1", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.state).toBe("done");
  });

  it("subagent_stop moves to done state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "subagent_stop", sessionId: "s1", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.state).toBe("done");
  });

  it("session_end removes the session", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "session_end", sessionId: "s1", ts: 1100 }));

    expect(state.getSnapshot().sessions).toHaveLength(0);
  });

  it("auto-creates a session for an unknown sessionId on arbitrary event", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "pre_tool", sessionId: "unknown", toolName: "Bash", ts: 1000 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "unknown");
    expect(session).toMatchObject({ state: "terminal", lastTs: 1000 });
  });
});

describe("OfficeState.prune", () => {
  it("removes sessions whose lastTs is more than 10 minutes before the injected now", () => {
    const state = new OfficeState();
    const tenMinutesMs = 10 * 60 * 1000;
    state.applyEvent(ev({ type: "session_start", sessionId: "stale", ts: 0 }));
    state.applyEvent(ev({ type: "session_start", sessionId: "fresh", ts: tenMinutesMs }));

    state.prune(tenMinutesMs + 1);

    const sessions = state.getSnapshot().sessions.map((s) => s.sessionId);
    expect(sessions).toEqual(["fresh"]);
  });

  it("keeps sessions exactly at the 10 minute boundary", () => {
    const state = new OfficeState();
    const tenMinutesMs = 10 * 60 * 1000;
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 0 }));

    state.prune(tenMinutesMs);

    expect(state.getSnapshot().sessions).toHaveLength(1);
  });
});

describe("OfficeState.applyEvent ordering defense", () => {
  it("discards an event whose seq is lower than the currently held seq", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, seq: 5 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 2000, seq: 3 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ state: "idle", lastTs: 1000 });
  });

  it("discards an event with an older ts when neither event carries a seq", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 200 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ state: "idle", lastTs: 200 });
  });

  it("falls back to ts comparison when the incoming event has no seq even though the held state does", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, seq: 5 }));
    // no seq on the incoming event; its ts is older than the held ts, so the
    // comparison must fall back to ts (not silently pass because seq is undefined)
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 900 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ state: "idle", lastTs: 1000 });
  });

  it("applies events normally when they arrive in increasing seq order (no regression)", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, seq: 1 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1100, seq: 2 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ state: "type", toolName: "Edit", lastTs: 1100 });
  });

  it("does not revive a session when an older pre_tool arrives after session_end (tombstone)", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "session_end", sessionId: "s1", ts: 2000 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1500 }));

    expect(state.getSnapshot().sessions.find((s) => s.sessionId === "s1")).toBeUndefined();
  });

  it("revives a tombstoned session when a newer session_start arrives", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "session_end", sessionId: "s1", ts: 2000 }));
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 3000 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ state: "idle", lastTs: 3000 });
  });

  it("removes a tombstone after prune(10 minutes) so a previously-blocked event can apply again", () => {
    const state = new OfficeState();
    const tenMinutesMs = 10 * 60 * 1000;
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "session_end", sessionId: "s1", ts: 2000 }));

    state.prune(2000 + tenMinutesMs + 1);

    // this event is older than the (now-pruned) tombstone watermark; it must
    // no longer be rejected once the tombstone itself has been removed
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1500 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ state: "type", toolName: "Edit", lastTs: 1500 });
  });

  it("applies a resend with an identical seq idempotently without corrupting state", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, seq: 5 }));
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, seq: 5 }));

    const snapshot = state.getSnapshot();
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({ sessionId: "s1", state: "idle", lastTs: 1000 });
  });
});

describe("OfficeState.applyEvent attribution passthrough", () => {
  it("carries org/dept/role from an event into the snapshot", () => {
    const state = new OfficeState();
    state.applyEvent(
      ev({
        type: "session_start",
        sessionId: "s1",
        ts: 1000,
        org: "domain-tech-collection",
        dept: "dept-engineering",
        role: "pipeline-dev",
      }),
    );

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({
      org: "domain-tech-collection",
      dept: "dept-engineering",
      role: "pipeline-dev",
    });
  });

  it("keeps the previously known attribution when a later event omits it", () => {
    const state = new OfficeState();
    state.applyEvent(
      ev({
        type: "session_start",
        sessionId: "s1",
        ts: 1000,
        org: "domain-tech-collection",
        dept: "dept-engineering",
        role: "pipeline-dev",
      }),
    );
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({
      state: "type",
      org: "domain-tech-collection",
      dept: "dept-engineering",
      role: "pipeline-dev",
    });
  });

  it("leaves attribution undefined when no event ever carried it", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.org).toBeUndefined();
    expect(session?.dept).toBeUndefined();
    expect(session?.role).toBeUndefined();
  });

  it("updates attribution when a later event carries a different value", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, org: "org-a" }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1100, org: "org-b" }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.org).toBe("org-b");
  });

  it("does not affect ordering-defense / tombstone behavior (regression guard)", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, org: "org-a" }));
    state.applyEvent(ev({ type: "session_end", sessionId: "s1", ts: 2000 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1500, org: "org-b" }));

    expect(state.getSnapshot().sessions.find((s) => s.sessionId === "s1")).toBeUndefined();
  });
});

describe("OfficeState.activeSubagents (M1-4b AC-1)", () => {
  it("starts every session with an empty activeSubagents array", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.activeSubagents).toEqual([]);
  });

  it("pre_tool with toolName Task pushes an entry carrying that event's own (subagent) attribution", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, org: "org-a", dept: "dept-parent", role: "parent-role" }));
    state.applyEvent(
      ev({
        type: "pre_tool",
        sessionId: "s1",
        toolName: "Task",
        subagentType: "researcher",
        ts: 1100,
        org: "org-a",
        dept: "dept-child",
        role: "child-role",
      }),
    );

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.activeSubagents).toEqual([
      { subagentType: "researcher", org: "org-a", dept: "dept-child", role: "child-role" },
    ]);
  });

  it("a non-Task pre_tool does not push onto activeSubagents", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "pre_tool", sessionId: "s1", toolName: "Edit", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.activeSubagents).toEqual([]);
  });

  it("subagent_stop pops the most recently pushed entry (LIFO)", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(
      ev({ type: "pre_tool", sessionId: "s1", toolName: "Task", subagentType: "a", ts: 1100, dept: "dept-a" }),
    );
    state.applyEvent(
      ev({ type: "pre_tool", sessionId: "s1", toolName: "Task", subagentType: "b", ts: 1200, dept: "dept-b" }),
    );

    let session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.activeSubagents).toHaveLength(2);

    state.applyEvent(ev({ type: "subagent_stop", sessionId: "s1", ts: 1300 }));

    session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    // LIFO: 最後に push された b が先に pop される
    expect(session?.activeSubagents).toEqual([{ subagentType: "a", org: undefined, dept: "dept-a", role: undefined }]);

    state.applyEvent(ev({ type: "subagent_stop", sessionId: "s1", ts: 1400 }));

    session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.activeSubagents).toEqual([]);
  });

  it("subagent_stop on a session with no active subagents is a harmless no-op", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));
    state.applyEvent(ev({ type: "subagent_stop", sessionId: "s1", ts: 1100 }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.activeSubagents).toEqual([]);
    expect(session?.state).toBe("done");
  });
});

describe("OfficeState.applyEvent Task attribution protection (M1-4b AC-1 — regression)", () => {
  // 現行バグの再現: Task の pre_tool/post_tool イベントは「呼び出した subagent 自身の
  // 帰属」を運ぶ（規則 3）。既存の attributionPatch はイベントに乗っている org/dept/role
  // を無条件に親セッションへ適用してしまうため、親の本来の帰属が subagent の帰属で
  // 上書きされてしまう（設計メモ rev.3 の HIGH finding）。この 2 件は red で現行バグを
  // 再現してから、Task イベントの帰属適用をスキップする修正で green にする。
  it("pre_tool(Task) does not overwrite the parent session's org/dept/role", () => {
    const state = new OfficeState();
    state.applyEvent(
      ev({ type: "session_start", sessionId: "s1", ts: 1000, org: "org-a", dept: "dept-parent", role: "parent-role" }),
    );
    state.applyEvent(
      ev({
        type: "pre_tool",
        sessionId: "s1",
        toolName: "Task",
        subagentType: "researcher",
        ts: 1100,
        org: "org-a",
        dept: "dept-child",
        role: "child-role",
      }),
    );

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ org: "org-a", dept: "dept-parent", role: "parent-role" });
  });

  it("post_tool(Task) does not overwrite the parent session's org/dept/role", () => {
    const state = new OfficeState();
    state.applyEvent(
      ev({ type: "session_start", sessionId: "s1", ts: 1000, org: "org-a", dept: "dept-parent", role: "parent-role" }),
    );
    state.applyEvent(
      ev({
        type: "pre_tool",
        sessionId: "s1",
        toolName: "Task",
        subagentType: "researcher",
        ts: 1100,
        org: "org-a",
        dept: "dept-child",
        role: "child-role",
      }),
    );
    state.applyEvent(
      ev({
        type: "post_tool",
        sessionId: "s1",
        toolName: "Task",
        subagentType: "researcher",
        ts: 1200,
        org: "org-a",
        dept: "dept-child",
        role: "child-role",
      }),
    );

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session).toMatchObject({ org: "org-a", dept: "dept-parent", role: "parent-role" });
  });

  it("a non-Task post_tool still applies attribution normally (no regression)", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000, org: "org-a" }));
    state.applyEvent(ev({ type: "post_tool", sessionId: "s1", toolName: "Edit", ts: 1100, org: "org-b" }));

    const session = state.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(session?.org).toBe("org-b");
  });
});

describe("OfficeState.subscribe", () => {
  it("notifies subscribers when applyEvent changes state", () => {
    const state = new OfficeState();
    const cb = vi.fn();
    state.subscribe(cb);

    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));

    expect(cb).toHaveBeenCalled();
  });

  it("notifies subscribers when prune removes a session", () => {
    const state = new OfficeState();
    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 0 }));

    const cb = vi.fn();
    state.subscribe(cb);
    state.prune(10 * 60 * 1000 + 1);

    expect(cb).toHaveBeenCalled();
  });

  it("returns an unsubscribe function that stops future notifications", () => {
    const state = new OfficeState();
    const cb = vi.fn();
    const unsubscribe = state.subscribe(cb);
    unsubscribe();

    state.applyEvent(ev({ type: "session_start", sessionId: "s1", ts: 1000 }));

    expect(cb).not.toHaveBeenCalled();
  });
});
