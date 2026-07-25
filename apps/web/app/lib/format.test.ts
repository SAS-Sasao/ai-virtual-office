import { describe, expect, it } from "vitest";
import { shortenSessionId } from "./format";

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
