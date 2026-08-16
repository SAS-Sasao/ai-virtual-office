import { OfficeEventSchema, type OfficeEvent } from "@ai-office/protocol";

/**
 * requestText（依頼文本文）の最大保存長。防御的な切り詰め上限であり、
 * 巨大ペイロード・事故的な大量データ混入を抑制する（ADR-007）。
 */
export const MAX_REQUEST_TEXT_LEN = 2000;

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
 * 依頼文候補を `requestText` へ変換する。空文字は付けない（undefined を返す）。
 * `MAX_REQUEST_TEXT_LEN` を超える場合は切り詰める（ADR-007）。
 * 呼び出し元は「依頼文キーとして正しい場所か」を先に判定してから渡すこと
 * （この関数自体は非文字列・空文字の防御のみを行う）。
 */
function toRequestText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value.length > MAX_REQUEST_TEXT_LEN ? value.slice(0, MAX_REQUEST_TEXT_LEN) : value;
}

/**
 * Claude Code hooks の stdin JSON を OfficeEvent へ正規化する。
 *
 * ホワイトリスト方式（NFR-4）: 出力に含めてよいのは
 * type / sessionId / toolName / fileBase（ベース名のみ）/ subagentType / ts のみ。
 * プロンプト本文・ファイル内容・Bash のコマンド・URL・cwd・transcript_path 等は
 * 一切コピーしない（読み取ってもいけない）。
 *
 * ⚠**例外（ADR-007 二層化）**: 依頼文キーのみ `requestText` としてホワイトリストに
 * 加える。対象は次の 2 つに厳しく限定する（それ以外の本文は従来どおり一切読まない）:
 *   - `type === "user_prompt"`（UserPromptSubmit）の `record.prompt`
 *   - `type === "pre_tool"` かつ `tool_name === "Task"` の `tool_input.prompt`
 * `requestText` は **ローカル配信専用**であり、クラウド転送境界では
 * `packages/relay/src/forward.ts` の `stripCloudSensitive` で必ず取り除く
 * （NFR-4 の「クラウドに本文を送らない」保証はクラウド境界の strip + テストで
 * 構造的に担保する）。ローカルでの依頼文保持自体は ADR-007 が公認している。
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

  // ADR-007 例外: UserPromptSubmit の prompt のみ、依頼文キーとして requestText 化する。
  let requestText: string | undefined =
    type === "user_prompt" ? toRequestText(record.prompt) : undefined;

  let fileBase: string | undefined;
  let subagentType: string | undefined;
  const toolInput = record.tool_input;
  if (typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)) {
    const toolInputRecord = toolInput as Record<string, unknown>;
    fileBase = toFileBase(toolInputRecord.file_path);
    subagentType =
      typeof toolInputRecord.subagent_type === "string" ? toolInputRecord.subagent_type : undefined;
    // ADR-007 例外: pre_tool かつ Task ツールの tool_input.prompt のみ requestText 化する。
    // Task 以外のツール（Bash の command・Edit の content/old_string/new_string 等）や
    // tool_input.prompt 以外のキーは決して requestText に載せない（NFR-4 スコープ厳守）。
    if (type === "pre_tool" && toolName === "Task") {
      requestText = toRequestText(toolInputRecord.prompt);
    }
  }

  const candidate: OfficeEvent = {
    type,
    sessionId,
    ts: now,
    ...(toolName !== undefined ? { toolName } : {}),
    ...(fileBase !== undefined ? { fileBase } : {}),
    ...(subagentType !== undefined ? { subagentType } : {}),
    ...(requestText !== undefined ? { requestText } : {}),
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
