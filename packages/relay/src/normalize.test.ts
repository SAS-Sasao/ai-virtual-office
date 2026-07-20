import { describe, expect, it } from "vitest";
import { normalizeHookEvent } from "./normalize.js";

const NOW = 1_700_000_000_000;

describe("normalizeHookEvent", () => {
  it("PreToolUse(Edit) を正規化し、file_path はベース名のみに落ち、機微情報は一切残らない", () => {
    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "session-abc",
      transcript_path: "/home/user/.claude/projects/foo/transcript.jsonl",
      cwd: "/home/user/secret/dir",
      tool_name: "Edit",
      tool_input: {
        file_path: "/home/user/secret/dir/App.tsx",
        content: "SECRET",
        old_string: "SECRET-OLD",
        new_string: "SECRET-NEW",
      },
    };

    const result = normalizeHookEvent(raw, NOW);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("pre_tool");
    expect(result?.sessionId).toBe("session-abc");
    expect(result?.toolName).toBe("Edit");
    expect(result?.fileBase).toBe("App.tsx");
    expect(result?.ts).toBe(NOW);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("/home/user");
    expect(serialized).not.toContain("secret");
  });

  it("UserPromptSubmit のプロンプト本文は出力に含まれない", () => {
    const raw = {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-abc",
      prompt: "機密プロンプト",
    };

    const result = normalizeHookEvent(raw, NOW);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("user_prompt");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("機密プロンプト");
  });

  it("Bash の command は出力に含まれない", () => {
    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "session-abc",
      tool_name: "Bash",
      tool_input: {
        command: "rm -rf /",
      },
    };

    const result = normalizeHookEvent(raw, NOW);

    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("Bash");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("rm -rf");
  });

  it("Task の subagent_type は残る", () => {
    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "session-abc",
      tool_name: "Task",
      tool_input: {
        subagent_type: "tech-researcher",
        prompt: "機密の指示文",
      },
    };

    const result = normalizeHookEvent(raw, NOW);

    expect(result).not.toBeNull();
    expect(result?.subagentType).toBe("tech-researcher");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("機密の指示文");
  });

  it("cwd / transcript_path は出力に含まれない", () => {
    const raw = {
      hook_event_name: "SessionStart",
      session_id: "session-abc",
      cwd: "/home/user/very-secret-project",
      transcript_path: "/home/user/.claude/projects/foo/transcript.jsonl",
    };

    const result = normalizeHookEvent(raw, NOW);

    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("very-secret-project");
    expect(serialized).not.toContain("transcript");
  });

  it("未知の hook_event_name は null を返す", () => {
    const raw = {
      hook_event_name: "SomeFutureHook",
      session_id: "session-abc",
    };

    expect(normalizeHookEvent(raw, NOW)).toBeNull();
  });

  it("session_id がない場合は null を返す", () => {
    const raw = {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
    };

    expect(normalizeHookEvent(raw, NOW)).toBeNull();
  });

  it("raw が object でない場合は null を返す（文字列）", () => {
    expect(normalizeHookEvent("not an object", NOW)).toBeNull();
  });

  it("raw が object でない場合は null を返す（null / 数値 / 配列）", () => {
    expect(normalizeHookEvent(null, NOW)).toBeNull();
    expect(normalizeHookEvent(42, NOW)).toBeNull();
    expect(normalizeHookEvent([1, 2, 3], NOW)).toBeNull();
  });

  it.each([
    ["SessionStart", "session_start"],
    ["UserPromptSubmit", "user_prompt"],
    ["PreToolUse", "pre_tool"],
    ["PostToolUse", "post_tool"],
    ["Notification", "notification"],
    ["Stop", "stop"],
    ["SubagentStop", "subagent_stop"],
    ["SessionEnd", "session_end"],
  ] as const)("%s -> type=%s", (hookEventName, expectedType) => {
    const raw = { hook_event_name: hookEventName, session_id: "session-abc" };
    const result = normalizeHookEvent(raw, NOW);
    expect(result?.type).toBe(expectedType);
  });

  it("ts は引数 now と一致する（内部で Date.now() を呼ばない）", () => {
    const raw = { hook_event_name: "Stop", session_id: "session-abc" };
    const result = normalizeHookEvent(raw, 12345);
    expect(result?.ts).toBe(12345);
  });

  it("file_path がバックスラッシュ区切りでもベース名のみになる", () => {
    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "session-abc",
      tool_name: "Write",
      tool_input: {
        file_path: "C:\\Users\\secret\\project\\index.ts",
      },
    };

    const result = normalizeHookEvent(raw, NOW);

    expect(result?.fileBase).toBe("index.ts");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("Users");
  });

  it("tool_input がない PostToolUse でも安全に null 系フィールドなしで正規化できる", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      session_id: "session-abc",
      tool_name: "Read",
    };

    const result = normalizeHookEvent(raw, NOW);

    expect(result).not.toBeNull();
    expect(result?.fileBase).toBeUndefined();
    expect(result?.subagentType).toBeUndefined();
  });
});
