import { afterEach, describe, expect, it } from "vitest";
import { createStatsCounter, getStats, resetStatsSingletonForTests } from "./stats";

describe("createStatsCounter（DI 可能な純カウンタ、AC-3）", () => {
  it("初期状態は全て 0", () => {
    const stats = createStatsCounter();
    expect(stats.snapshot()).toEqual({
      acceptedCount: 0,
      droppedCount: 0,
      dropped: { schema: 0, unparseable: 0 },
    });
  });

  it("recordAccepted() で acceptedCount が増える", () => {
    const stats = createStatsCounter();
    stats.recordAccepted();
    stats.recordAccepted();
    expect(stats.snapshot().acceptedCount).toBe(2);
  });

  it("recordDropped(reason) で理由別に加算され、droppedCount は合計になる", () => {
    const stats = createStatsCounter();
    stats.recordDropped("schema");
    stats.recordDropped("schema");
    stats.recordDropped("unparseable");

    const snap = stats.snapshot();
    expect(snap.dropped).toEqual({ schema: 2, unparseable: 1 });
    expect(snap.droppedCount).toBe(3);
  });

  it("独立したインスタンス同士は状態を共有しない（DI で決定論的にテストできる）", () => {
    const a = createStatsCounter();
    const b = createStatsCounter();
    a.recordAccepted();
    a.recordDropped("schema");

    expect(b.snapshot()).toEqual({
      acceptedCount: 0,
      droppedCount: 0,
      dropped: { schema: 0, unparseable: 0 },
    });
  });
});

describe("getStats（globalThis シングルトン。bus.ts/db/client.ts と同じ dev ホットリロード対策パターン）", () => {
  afterEach(() => {
    resetStatsSingletonForTests();
  });

  it("複数回呼んでも同一インスタンスを返す", () => {
    const first = getStats();
    first.recordAccepted();

    const second = getStats();
    expect(second.snapshot().acceptedCount).toBe(1);
    expect(second).toBe(first);
  });

  it("resetStatsSingletonForTests() でシングルトンをリセットできる（テスト隔離用）", () => {
    getStats().recordAccepted();
    resetStatsSingletonForTests();
    expect(getStats().snapshot().acceptedCount).toBe(0);
  });
});
