import { describe, expect, it } from "vitest";
import type { Character, OfficeEvent } from "@ai-office/protocol";
import { buildNarrationText, resolveReceptionistName } from "./narration";

function ev(partial: Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">): OfficeEvent {
  return partial;
}

describe("resolveReceptionistName (M1-4b: ナレーションバーの「受付キャラ名」)", () => {
  it("returns the name of the character in dept-secretary", () => {
    const characters: Character[] = [
      { id: "org:secretary", name: "Aoi", role: "secretary", dept: "dept-secretary", org: "org" },
      { id: "org:researcher", name: "Ren", role: "researcher", dept: "dept-research", org: "org" },
    ];
    expect(resolveReceptionistName(characters)).toBe("Aoi");
  });

  it("falls back to オフィス when no dept-secretary character exists (fallback layout / custom org)", () => {
    const characters: Character[] = [
      { id: "org:researcher", name: "Ren", role: "researcher", dept: "dept-research", org: "org" },
    ];
    expect(resolveReceptionistName(characters)).toBe("オフィス");
  });

  it("falls back to オフィス for an empty roster", () => {
    expect(resolveReceptionistName([])).toBe("オフィス");
  });
});

describe("buildNarrationText (M1-4b: 直近イベントの実況文。可視化のみ・操作系ではない)", () => {
  it("returns a quiet default when there is no recent event", () => {
    expect(buildNarrationText(null)).toBe("オフィスは静かです。");
  });

  it("prefers the attributed role over the raw sessionId when present", () => {
    const text = buildNarrationText(ev({ type: "session_start", sessionId: "sess-1234567890", ts: 1000, role: "tech-researcher" }));
    expect(text).toContain("tech-researcher");
    expect(text).not.toContain("sess-1234567890");
  });

  it("falls back to a shortened sessionId when no role attribution is present", () => {
    const text = buildNarrationText(ev({ type: "session_start", sessionId: "sess-1234567890", ts: 1000 }));
    expect(text).toContain("sess-123"); // shortenSessionId の既定 8 文字
  });

  it.each([
    ["session_start", "出社しました"],
    ["user_prompt", "指示を受け取りました"],
    ["notification", "確認を待っています"],
    ["stop", "作業を完了しました"],
    ["subagent_stop", "サブエージェントが完了しました"],
    ["session_end", "退社しました"],
  ] as const)("renders a %s narration line ending in the expected Japanese phrase", (type, phrase) => {
    const text = buildNarrationText(ev({ type, sessionId: "sess-1", ts: 1000, role: "worker" }));
    expect(text).toContain(phrase);
  });

  it("includes the tool name for pre_tool events", () => {
    const text = buildNarrationText(ev({ type: "pre_tool", sessionId: "sess-1", ts: 1000, role: "worker", toolName: "Edit" }));
    expect(text).toContain("Edit");
  });

  it("falls back to a generic label for pre_tool events without a toolName", () => {
    const text = buildNarrationText(ev({ type: "pre_tool", sessionId: "sess-1", ts: 1000, role: "worker" }));
    expect(text).toContain("ツール");
  });

  it("includes the tool name for post_tool events", () => {
    const text = buildNarrationText(ev({ type: "post_tool", sessionId: "sess-1", ts: 1000, role: "worker", toolName: "Read" }));
    expect(text).toContain("Read");
  });
});

describe("buildNarrationText requestText (ADR-007 (b)-1 AC-10: 作業依頼本文を織り込む)", () => {
  it("appends the requestText to a user_prompt narration line", () => {
    const text = buildNarrationText(
      ev({ type: "user_prompt", sessionId: "sess-1", ts: 1000, role: "worker", requestText: "実装して" }),
    );
    expect(text).toContain("指示を受け取りました");
    expect(text).toContain("実装して");
  });

  it("appends the requestText to a pre_tool(Task) narration line as well", () => {
    const text = buildNarrationText(
      ev({
        type: "pre_tool",
        sessionId: "sess-1",
        ts: 1000,
        role: "worker",
        toolName: "Task",
        requestText: "調査して",
      }),
    );
    expect(text).toContain("Task");
    expect(text).toContain("調査して");
  });

  it("truncates a long requestText using the shared 40-char limit", () => {
    const long = "a".repeat(50);
    const text = buildNarrationText(ev({ type: "user_prompt", sessionId: "sess-1", ts: 1000, role: "worker", requestText: long }));
    expect(text).toContain(`${"a".repeat(40)}…`);
    expect(text).not.toContain(long);
  });

  it("keeps the traditional fixed phrase unchanged when requestText is absent (no regression)", () => {
    const text = buildNarrationText(ev({ type: "user_prompt", sessionId: "sess-1", ts: 1000, role: "worker" }));
    expect(text).toBe("worker が 指示を受け取りました");
  });
});
