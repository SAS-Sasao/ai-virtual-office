import { describe, expect, it } from "vitest";
import { listenerCount, publish, subscribe } from "./bus";

/**
 * `lib/bus.ts` はテストプロセス全体で共有される globalThis シングルトンのため
 * （`app/api/ingest/route.test.ts` の既存コメント参照）、各テストで
 * subscribe → 検証 → 必ず unsubscribe して購読リークを防ぐ。
 */

describe("bus.listenerCount()（AC-6: 購読解除の決定論観測 seam。既存 publish/subscribe は不変）", () => {
  it("subscribe すると +1、解除関数を呼ぶと -1 に戻る", () => {
    const baseline = listenerCount();

    const unsubscribe = subscribe(() => {});
    expect(listenerCount()).toBe(baseline + 1);

    unsubscribe();
    expect(listenerCount()).toBe(baseline);
  });

  it("複数の購読者を個別に解除できる", () => {
    const baseline = listenerCount();

    const unsubscribeA = subscribe(() => {});
    const unsubscribeB = subscribe(() => {});
    expect(listenerCount()).toBe(baseline + 2);

    unsubscribeA();
    expect(listenerCount()).toBe(baseline + 1);

    unsubscribeB();
    expect(listenerCount()).toBe(baseline);
  });

  it("同じ解除関数を2回呼んでもカウントは負にならない（Set.delete の冪等性）", () => {
    const baseline = listenerCount();

    const unsubscribe = subscribe(() => {});
    unsubscribe();
    unsubscribe();

    expect(listenerCount()).toBe(baseline);
  });
});

describe("publish/subscribe（既存の振る舞いの回帰確認。listenerCount 追加による副作用が無いこと）", () => {
  it("publish は購読中の全リスナーへイベントを配る", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribe((ev) => received.push(ev));

    const event = { type: "session_start" as const, sessionId: "bus-test-1", ts: 1 };
    publish(event);

    unsubscribe();
    expect(received).toEqual([event]);
  });

  it("あるリスナーが例外を投げても他のリスナーへの配信は継続する", () => {
    const received: unknown[] = [];
    const unsubscribeThrowing = subscribe(() => {
      throw new Error("boom");
    });
    const unsubscribeOk = subscribe((ev) => received.push(ev));

    const event = { type: "session_start" as const, sessionId: "bus-test-2", ts: 2 };
    expect(() => publish(event)).not.toThrow();

    unsubscribeThrowing();
    unsubscribeOk();
    expect(received).toEqual([event]);
  });
});
