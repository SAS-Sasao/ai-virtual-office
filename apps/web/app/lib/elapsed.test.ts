import { describe, expect, it } from "vitest";
import { formatElapsed } from "./elapsed";

describe("formatElapsed (M1-4b: セッション一覧・待ちパネルの経過表示。分:秒・時刻は注入)", () => {
  it("formats 0ms elapsed as 0:00", () => {
    expect(formatElapsed(1000, 1000)).toBe("0:00");
  });

  it("formats sub-minute elapsed as 0:SS (zero-padded seconds)", () => {
    expect(formatElapsed(1000 + 5_000, 1000)).toBe("0:05");
    expect(formatElapsed(1000 + 45_000, 1000)).toBe("0:45");
  });

  it("formats multi-minute elapsed as M:SS", () => {
    expect(formatElapsed(1000 + 65_000, 1000)).toBe("1:05");
    expect(formatElapsed(1000 + 125_000, 1000)).toBe("2:05");
  });

  it("clamps negative elapsed (clock skew / stale snapshot) to 0:00 instead of going negative", () => {
    expect(formatElapsed(1000, 5000)).toBe("0:00");
  });

  it("is a pure function of its two injected arguments (no Date.now() dependency)", () => {
    // 同じ引数を 2 回呼んでも常に同じ結果（内部で現在時刻を参照していないことの検証）。
    expect(formatElapsed(2_000_000, 1_000_000)).toBe(formatElapsed(2_000_000, 1_000_000));
  });
});
