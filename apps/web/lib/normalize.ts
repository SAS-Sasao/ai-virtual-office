import { OfficeEventSchema, type OfficeEvent } from "../game/protocol";

/**
 * Claude Code hooks の hook_event_name → OfficeEvent.type 対応表。
 * ここに載っていないイベント名は無視する（null を返す）。
 */
const EVENT_TYPE_MAP: Record<string, OfficeEvent["type"]> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt",
  PreToolUse: "pre_tool",
  PostToolUse: "post_tool",
  Notification: "notification",
  Stop: "stop",
  SubagentStop: "subagent_stop",
  SessionEnd: "session_end",
};

/**
 * ファイルパスからベース名のみを取り出す。'/' と '\\' の両方の区切り文字に対応する。
 * ディレクトリ名・絶対パス等の機微情報を残さないための処理（NFR-4）。
 */
function toFileBase(filePath: unknown): string | undefined {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return undefined;
  }
  const segments = filePath.split(/[\\/]/);
  const base = segments[segments.length - 1];
  return base.length > 0 ? base : undefined;
}

/**
 * Claude Code hooks の stdin JSON を OfficeEvent へ正規化する。
 *
 * ホワイトリスト方式（NFR-4）: 出力に含めてよいのは
 * type / sessionId / toolName / fileBase（ベース名のみ）/ subagentType / ts のみ。
 * プロンプト本文・ファイル内容・Bash のコマンド・URL・cwd・transcript_path 等は
 * 一切コピーしない（読み取ってもいけない）。
 *
 * 時刻は必ず呼び出し側から `now` として注入すること。この関数内で
 * Date.now() を呼び出してはならない（テストの決定論性を保つため）。
 */
export function normalizeHookEvent(raw: unknown, now: number): OfficeEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;

  const hookEventName = record.hook_event_name;
  if (typeof hookEventName !== "string") {
    return null;
  }

  const type = EVENT_TYPE_MAP[hookEventName];
  if (!type) {
    return null;
  }

  const sessionId = record.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }

  const toolName = typeof record.tool_name === "string" ? record.tool_name : undefined;

  let fileBase: string | undefined;
  let subagentType: string | undefined;
  const toolInput = record.tool_input;
  if (typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)) {
    const toolInputRecord = toolInput as Record<string, unknown>;
    fileBase = toFileBase(toolInputRecord.file_path);
    subagentType =
      typeof toolInputRecord.subagent_type === "string" ? toolInputRecord.subagent_type : undefined;
  }

  const candidate: OfficeEvent = {
    type,
    sessionId,
    ts: now,
    ...(toolName !== undefined ? { toolName } : {}),
    ...(fileBase !== undefined ? { fileBase } : {}),
    ...(subagentType !== undefined ? { subagentType } : {}),
  };

  return OfficeEventSchema.parse(candidate);
}
