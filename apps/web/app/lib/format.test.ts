import { describe, expect, it } from "vitest";
import { shortenSessionId, truncateText } from "./format";

describe("shortenSessionId (M1-4b: セッション一覧/イベントログ表示用)", () => {
  it("returns the id unchanged when it is at or under the default length (8)", () => {
    expect(shortenSessionId("sess-1")).toBe("sess-1");
    expect(shortenSessionId("12345678")).toBe("12345678");
  });

  it("truncates ids longer than the default length to 8 characters", () => {
    expect(shortenSessionId("session-abcdef1234567890")).toBe("session-");
  });

  it("honors a custom length argument", () => {
    expect(shortenSessionId("session-abcdef", 4)).toBe("sess");
  });
});

describe("truncateText (ADR-007 (b)-1 AC-9/AC-10: requestText の短縮表示)", () => {
  it("returns the text unchanged when it is at or under the default length (40)", () => {
    expect(truncateText("実装して")).toBe("実装して");
    expect(truncateText("a".repeat(40))).toBe("a".repeat(40));
  });

  it("truncates text longer than the default length and appends an ellipsis", () => {
    const long = "a".repeat(50);
    const result = truncateText(long);
    expect(result).toBe(`${"a".repeat(40)}…`);
    expect(result.length).toBe(41);
  });

  it("honors a custom length argument", () => {
    expect(truncateText("abcdefgh", 4)).toBe("abcd…");
  });
});
