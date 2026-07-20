import { describe, expect, it } from "vitest";
import { HOOKS_SPEC, MARKER, buildCommand, buildTargetUrl } from "./hooks-spec.js";

describe("HOOKS_SPEC", () => {
  it("要件 §5.2 の 8 イベントを定義する", () => {
    expect(HOOKS_SPEC).toHaveLength(8);
    expect(HOOKS_SPEC.map((e) => e.event)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SubagentStop",
      "SessionEnd",
    ]);
  });

  it("slug がすべて一意", () => {
    const slugs = HOOKS_SPEC.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("PreToolUse / PostToolUse のみ matcher: '*' を持ち、他 6 件は matcher キーを持たない", () => {
    for (const entry of HOOKS_SPEC) {
      if (entry.event === "PreToolUse" || entry.event === "PostToolUse") {
        expect(entry.matcher).toBe("*");
      } else {
        expect(entry.matcher).toBeUndefined();
      }
    }
  });
});

describe("buildCommand", () => {
  it("NFR-2 準拠のコマンド文字列を生成する（--max-time 2 / || true / マーカー必須）", () => {
    for (const entry of HOOKS_SPEC) {
      const command = buildCommand(entry.slug, 4100);
      expect(command).toContain("--max-time 2");
      expect(command).toContain("|| true");
      expect(command).toContain(MARKER);
      expect(command).toContain(`http://localhost:4100/hooks/${entry.slug}`);
      expect(command.startsWith("curl -s -X POST")).toBe(true);
    }
  });

  it("port を反映する", () => {
    expect(buildCommand("session-start", 5000)).toContain("http://localhost:5000/hooks/session-start");
  });

  it("マーカーは #ai-office:cli（本リポジトリの手書き #ai-office とは区別される）", () => {
    expect(MARKER).toBe("#ai-office:cli");
    expect(buildCommand("stop", 4100).endsWith(MARKER)).toBe(true);
  });
});

describe("buildTargetUrl", () => {
  it("slug と port から URL を組み立てる", () => {
    expect(buildTargetUrl("pre-tool", 4100)).toBe("http://localhost:4100/hooks/pre-tool");
  });
});
