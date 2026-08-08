import { OfficeEventSchema, type OfficeEvent } from "@ai-office/protocol";

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
 *
 * AC-8 defense-in-depth: ベース名確定後、残り得る `?query` / `#fragment` を
 * 切り落とす（`file_path` は本来 URL ではないが、ツールによってはクエリ文字列
 * 相当のものが紛れ込む可能性があるため NFR-4「URL クエリ破棄」を優先する）。
 * strip した結果が空文字になる場合（例: ベース名が `?x=1` のように `?`/`#` から
 * 始まる場合）は strip 前の base にフォールバックする —
 * 正当なファイル名を空文字に落とさないため。POSIX では `?`/`#` はファイル名の
 * 合法な文字だが、この稀なトレードオフより NFR-4 の防御を優先して受容する。
 */
function toFileBase(filePath: unknown): string | undefined {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return undefined;
  }
  const segments = filePath.split(/[\\/]/);
  const base = segments[segments.length - 1];
  if (base.length === 0) {
    return undefined;
  }
  const stripped = base.split(/[?#]/)[0];
  return stripped.length > 0 ? stripped : base;
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

  // AC-7 defense-in-depth: candidate はここまでの検証済みフィールドから構築して
  // おり、現状は常に OfficeEventSchema を満たす（= この分岐は理論上到達しない）。
  // それでも `.parse` ではなく `.safeParse` を使うのは、呼び出し元
  // （server.ts の /hooks/:event ハンドラ）が try/catch の外でこの関数を呼ぶため、
  // 将来の変更で candidate が invalid になり得た場合に throw が NFR-2（hooks は
  // 絶対にブロックしない）を破ってしまう事故を未然に防ぐため。失敗は null を
  // 返す契約に統一する（呼び出し元は既存どおり null を「無視」として扱う）。
  const result = OfficeEventSchema.safeParse(candidate);
  if (!result.success) {
    return null;
  }
  return result.data;
}
