import { describe, expect, it } from "vitest";
import {
  CharacterStateSchema,
  OfficeEventSchema,
  type CharacterState,
} from "./events.js";

describe("OfficeEventSchema", () => {
  it("parses a minimal valid event (type/sessionId/ts only)", () => {
    const input = {
      type: "session_start",
      sessionId: "sess-1",
      ts: 1_700_000_000_000,
    };

    const result = OfficeEventSchema.parse(input);

    expect(result).toEqual(input);
  });

  it("parses a full valid event (toolName/fileBase/subagentType/seq included)", () => {
    const input = {
      type: "pre_tool",
      sessionId: "sess-1",
      toolName: "Edit",
      fileBase: "events.ts",
      subagentType: "pipeline-dev",
      ts: 1_700_000_000_000,
      seq: 42,
    };

    const result = OfficeEventSchema.parse(input);

    expect(result).toEqual(input);
  });

  it("accepts every documented type enum value", () => {
    const types = [
      "session_start",
      "user_prompt",
      "pre_tool",
      "post_tool",
      "notification",
      "stop",
      "subagent_stop",
      "session_end",
    ];

    for (const type of types) {
      const result = OfficeEventSchema.safeParse({
        type,
        sessionId: "sess-1",
        ts: 0,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a type outside the enum", () => {
    const result = OfficeEventSchema.safeParse({
      type: "unknown_type",
      sessionId: "sess-1",
      ts: 1_700_000_000_000,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty sessionId", () => {
    const result = OfficeEventSchema.safeParse({
      type: "session_start",
      sessionId: "",
      ts: 1_700_000_000_000,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing ts", () => {
    const result = OfficeEventSchema.safeParse({
      type: "session_start",
      sessionId: "sess-1",
    });

    expect(result.success).toBe(false);
  });

  it("strips unknown keys instead of passing them through (NFR-4 defense in depth)", () => {
    const input = {
      type: "user_prompt",
      sessionId: "sess-1",
      ts: 1_700_000_000_000,
      prompt: "this is a secret prompt that must never leak",
      tool_input: { content: "sensitive file content" },
      cwd: "/home/someone/secret-project",
    };

    const result = OfficeEventSchema.parse(input);

    expect(Object.keys(result).sort()).toEqual(["sessionId", "ts", "type"]);
    expect(result).not.toHaveProperty("prompt");
    expect(result).not.toHaveProperty("tool_input");
    expect(result).not.toHaveProperty("cwd");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("allows seq to be omitted", () => {
    const result = OfficeEventSchema.safeParse({
      type: "session_start",
      sessionId: "sess-1",
      ts: 0,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBeUndefined();
    }
  });

  it("rejects a negative seq", () => {
    const result = OfficeEventSchema.safeParse({
      type: "session_start",
      sessionId: "sess-1",
      ts: 0,
      seq: -1,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a non-integer (decimal) seq", () => {
    const result = OfficeEventSchema.safeParse({
      type: "session_start",
      sessionId: "sess-1",
      ts: 0,
      seq: 1.5,
    });

    expect(result.success).toBe(false);
  });
});

describe("CharacterStateSchema", () => {
  it("accepts all 8 documented states", () => {
    const states = [
      "idle",
      "type",
      "read",
      "terminal",
      "browsing",
      "thinking",
      "waiting",
      "done",
    ];

    for (const state of states) {
      expect(CharacterStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it("rejects an unknown state", () => {
    const result = CharacterStateSchema.safeParse("sleeping");

    expect(result.success).toBe(false);
  });

  it("infers a CharacterState type usable as a literal union", () => {
    const state: CharacterState = "idle";
    expect(CharacterStateSchema.safeParse(state).success).toBe(true);
  });
});
