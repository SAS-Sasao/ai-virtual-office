import { describe, expect, it, vi } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { createRetryBuffer, type ScheduleTimer } from "./buffer.js";

function makeEvent(overrides: Partial<OfficeEvent> = {}): OfficeEvent {
  return { type: "session_start", sessionId: "s1", ts: 1, ...overrides };
}

/**
 * scheduleTimer を実時間 sleep 無しで手動駆動するためのテスト用ダブル。
 * 登録された fn は実際には async の場合があるため（本番は setTimeout に渡すだけで
 * 実害は無い）、fireNext/fireAll は fn() の戻り値を await してから返す。
 */
function makeManualTimer() {
  const calls: Array<{ fn: () => void; ms: number }> = [];
  const scheduleTimer: ScheduleTimer = (fn, ms) => {
    calls.push({ fn, ms });
  };
  return {
    scheduleTimer,
    calls,
    async fireNext(): Promise<void> {
      const next = calls.shift();
      if (!next) {
        throw new Error("no scheduled timer to fire");
      }
      await next.fn();
    },
    async fireAll(): Promise<void> {
      while (calls.length > 0) {
        const next = calls.shift();
        if (!next) break;
        await next.fn();
      }
    },
  };
}

describe("createRetryBuffer", () => {
  it("does not enqueue when the direct forward succeeds", async () => {
    const forward = vi.fn(async () => true);
    const timer = makeManualTimer();
    const buffer = createRetryBuffer({ forward, scheduleTimer: timer.scheduleTimer });

    await buffer.send(makeEvent());

    expect(forward).toHaveBeenCalledTimes(1);
    expect(buffer.size()).toBe(0);
    expect(timer.calls).toHaveLength(0);
  });

  it("enqueues the event and schedules a retry (at initialDelayMs) when the direct forward fails", async () => {
    const forward = vi.fn(async () => false);
    const timer = makeManualTimer();
    const buffer = createRetryBuffer({
      forward,
      scheduleTimer: timer.scheduleTimer,
      initialDelayMs: 100,
    });

    await buffer.send(makeEvent());

    expect(buffer.size()).toBe(1);
    expect(timer.calls).toHaveLength(1);
    expect(timer.calls[0].ms).toBe(100);
  });

  it("always attempts a direct send for new events even while the buffer is non-empty (no head-of-line blocking)", async () => {
    const forward = vi.fn<(event: OfficeEvent) => Promise<boolean>>();
    forward.mockResolvedValueOnce(false); // "a" fails -> buffered
    forward.mockResolvedValueOnce(true); // "b" succeeds directly, despite "a" still buffered

    const timer = makeManualTimer();
    const buffer = createRetryBuffer({ forward, scheduleTimer: timer.scheduleTimer });

    await buffer.send(makeEvent({ sessionId: "a" }));
    expect(buffer.size()).toBe(1);

    await buffer.send(makeEvent({ sessionId: "b" }));

    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward.mock.calls[1][0].sessionId).toBe("b");
    // "b" was delivered directly and must not sit behind "a" in the buffer.
    expect(buffer.size()).toBe(1);
  });

  it("drains all buffered events in a single retry cycle once forward recovers (not one per tick)", async () => {
    const forward = vi.fn<(event: OfficeEvent) => Promise<boolean>>(async () => false);
    const timer = makeManualTimer();
    const buffer = createRetryBuffer({
      forward,
      scheduleTimer: timer.scheduleTimer,
      initialDelayMs: 50,
    });

    await buffer.send(makeEvent({ sessionId: "a" }));
    await buffer.send(makeEvent({ sessionId: "b" }));
    await buffer.send(makeEvent({ sessionId: "c" }));

    expect(buffer.size()).toBe(3);
    // 3 failed enqueues must still dedup to a single pending retry timer.
    expect(timer.calls).toHaveLength(1);

    forward.mockResolvedValue(true);
    await timer.fireNext();

    expect(buffer.size()).toBe(0);
    expect(timer.calls).toHaveLength(0); // fully drained -> no further retry scheduled
    // 3 direct attempts (failed) + 3 drain attempts (succeeded) = 6.
    expect(forward).toHaveBeenCalledTimes(6);
    const drainedOrder = forward.mock.calls.slice(3).map(([event]) => event.sessionId);
    expect(drainedOrder).toEqual(["a", "b", "c"]);
  });

  it("backs off exponentially on repeated retry failures, capped at maxDelayMs", async () => {
    const forward = vi.fn<(event: OfficeEvent) => Promise<boolean>>(async () => false);
    const timer = makeManualTimer();
    const buffer = createRetryBuffer({
      forward,
      scheduleTimer: timer.scheduleTimer,
      initialDelayMs: 100,
      maxDelayMs: 350,
    });

    await buffer.send(makeEvent());
    expect(timer.calls.map((c) => c.ms)).toEqual([100]);

    await timer.fireNext(); // retry attempt fails -> 100 * 2 = 200
    expect(timer.calls.map((c) => c.ms)).toEqual([200]);

    await timer.fireNext(); // retry attempt fails -> 200 * 2 = 400, capped to 350
    expect(timer.calls.map((c) => c.ms)).toEqual([350]);

    await timer.fireNext(); // retry attempt fails -> stays capped at 350
    expect(timer.calls.map((c) => c.ms)).toEqual([350]);
  });

  it("resets the backoff delay back to initialDelayMs after a successful retry", async () => {
    const forward = vi.fn<(event: OfficeEvent) => Promise<boolean>>(async () => false);
    const timer = makeManualTimer();
    const buffer = createRetryBuffer({
      forward,
      scheduleTimer: timer.scheduleTimer,
      initialDelayMs: 100,
    });

    await buffer.send(makeEvent({ sessionId: "a" }));
    await timer.fireNext(); // fails again -> delay becomes 200
    expect(timer.calls.map((c) => c.ms)).toEqual([200]);

    forward.mockResolvedValue(true);
    await timer.fireNext(); // succeeds, buffer drains, delay resets
    expect(buffer.size()).toBe(0);

    forward.mockResolvedValue(false);
    await buffer.send(makeEvent({ sessionId: "b" }));
    // a fresh failure after a full recovery must schedule at initialDelayMs again, not 200.
    expect(timer.calls.map((c) => c.ms)).toEqual([100]);
  });

  it("drops the oldest buffered event and warns (not silently) when maxSize is exceeded", async () => {
    const forward = vi.fn<(event: OfficeEvent) => Promise<boolean>>(async () => false);
    const timer = makeManualTimer();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const buffer = createRetryBuffer({
      forward,
      scheduleTimer: timer.scheduleTimer,
      maxSize: 2,
      initialDelayMs: 10,
    });

    await buffer.send(makeEvent({ sessionId: "a" }));
    await buffer.send(makeEvent({ sessionId: "b" }));
    await buffer.send(makeEvent({ sessionId: "c" })); // exceeds maxSize=2 -> "a" dropped

    expect(buffer.size()).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1"));

    forward.mockResolvedValue(true);
    await timer.fireNext();

    const drainedOrder = forward.mock.calls.slice(3).map(([event]) => event.sessionId);
    expect(drainedOrder).toEqual(["b", "c"]); // "a" never reappears

    warnSpy.mockRestore();
  });

  it("defaults maxSize/initialDelayMs/maxDelayMs when not provided", async () => {
    const forward = vi.fn(async () => true);
    const timer = makeManualTimer();
    const buffer = createRetryBuffer({ forward, scheduleTimer: timer.scheduleTimer });

    expect(buffer.size()).toBe(0);
    await buffer.send(makeEvent());
    expect(buffer.size()).toBe(0);
  });

  it("never has two forward() calls for the same buffered event in flight at once (no reentrant drain)", async () => {
    // Phase 3 レビュー medium finding: scheduleRetry のタイマー callback が
    // 先頭で retryScheduled = false にしてから await drain() するため、drain
    // が forward を await 中に新規 send() が失敗すると 2 本目のタイマーが
    // 予約され、drain が並行起動して同じ queue[0] を二重に forward しうる。
    //
    // forward が外部から解決できる Promise を返すようにして「drain が
    // forward を await 中」の滞留状態を人工的に作り、その間に 2 本目の
    // タイマーを発火させても forward("e1") が同時に 2 回 in-flight にならない
    // ことを確認する。
    const timer = makeManualTimer();
    const callLog: string[] = [];
    const pendingBySession = new Map<string, Array<(ok: boolean) => void>>();
    const inFlight = new Map<string, number>();
    let maxConcurrentE1 = 0;

    const forward = (event: OfficeEvent): Promise<boolean> => {
      const id = event.sessionId;
      callLog.push(id);
      const count = (inFlight.get(id) ?? 0) + 1;
      inFlight.set(id, count);
      if (id === "e1") {
        maxConcurrentE1 = Math.max(maxConcurrentE1, count);
      }
      return new Promise<boolean>((resolve) => {
        const list = pendingBySession.get(id) ?? [];
        list.push((ok) => {
          inFlight.set(id, (inFlight.get(id) ?? 1) - 1);
          resolve(ok);
        });
        pendingBySession.set(id, list);
      });
    };

    async function resolveOldestFor(id: string, ok: boolean): Promise<void> {
      const list = pendingBySession.get(id);
      const resolve = list?.shift();
      if (!resolve) {
        throw new Error(`no pending forward("${id}") call to resolve`);
      }
      resolve(ok);
      await Promise.resolve();
      await Promise.resolve();
    }

    const buffer = createRetryBuffer({ forward, scheduleTimer: timer.scheduleTimer, initialDelayMs: 10 });

    // 1. direct send("e1") fails -> buffered + retry timer T1 scheduled.
    const sendE1 = buffer.send(makeEvent({ sessionId: "e1" }));
    await resolveOldestFor("e1", false);
    await sendE1;
    expect(timer.calls).toHaveLength(1);

    // 2. fire T1 -> drain() starts, calls forward("e1") again, and we
    //    deliberately leave it pending -- this simulates "drain が forward を
    //    await 中"。
    const drainDone = timer.fireNext();
    await Promise.resolve();
    await Promise.resolve();
    expect(callLog).toEqual(["e1", "e1"]);

    // 3. while drain() is still stuck on that pending forward("e1"), a
    //    concurrent send("e2") fails too -- this is what schedules the
    //    second timer.
    const sendE2 = buffer.send(makeEvent({ sessionId: "e2" }));
    await resolveOldestFor("e2", false);
    await sendE2;

    // 4. Firing that second timer must not start a second, reentrant drain()
    //    that re-reads queue[0] (still "e1") and calls forward("e1") again
    //    while the first call from step 2 is still unresolved. Fire it
    //    without awaiting full completion: on buggy code the reentrant
    //    drain() suspends forever on a forward("e1") call nobody resolves,
    //    so a full `await` here would hang the test instead of failing
    //    cleanly. A couple of microtask flushes are enough for the buggy
    //    synchronous prefix (the extra forward("e1") call) to run if present.
    if (timer.calls.length > 0) {
      const next = timer.calls.shift();
      if (next) {
        void next.fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(maxConcurrentE1).toBe(1);

    // cleanup: resolve the remaining pending calls so drain() can finish and
    // nothing is left hanging for later tests.
    await resolveOldestFor("e1", true);
    await resolveOldestFor("e2", true);
    await drainDone;

    expect(buffer.size()).toBe(0);
  });
});
