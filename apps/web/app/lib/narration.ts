// 秘書ナレーションバー用のロジック（M1-4b・設計メモ「スコープ判断」）。
//
// 【最重要制約】ナレーションバーは「可視化のみ」。ここには操作系（承認/停止/報告）の
// 判断ロジックを一切書かない。本モジュールは「表示するテキストを組み立てる」純関数
// のみを持つ（apps/web/game と同じ「テスタビリティは後付けしない」方針）。
import type { Character, OfficeEvent } from "@ai-office/protocol";
import { RECEPTION_DEPT_ID } from "../../game/layout-runtime";
import { shortenSessionId, truncateText } from "./format";

const DEFAULT_RECEPTIONIST_NAME = "オフィス";
const DEFAULT_NARRATION_TEXT = "オフィスは静かです。";
const DEFAULT_TOOL_LABEL = "ツール";

/**
 * 受付キャラ名（layout の `dept-secretary` 所属キャラ）。見つからない場合は
 * 「オフィス」（フォールバックレイアウト・受付部署未定義の組織向け）。
 */
export function resolveReceptionistName(characters: readonly Character[]): string {
  const receptionist = characters.find((c) => c.dept === RECEPTION_DEPT_ID);
  return receptionist?.name ?? DEFAULT_RECEPTIONIST_NAME;
}

const EVENT_PHRASES: Record<Exclude<OfficeEvent["type"], "pre_tool" | "post_tool">, string> = {
  session_start: "出社しました",
  user_prompt: "指示を受け取りました",
  notification: "確認を待っています",
  stop: "作業を完了しました",
  subagent_stop: "サブエージェントが完了しました",
  session_end: "退社しました",
};

function subjectOf(event: OfficeEvent): string {
  return event.role ?? shortenSessionId(event.sessionId);
}

/**
 * 依頼文本文（requestText, ADR-007 (b)-1）があれば、定型文の末尾に短縮した
 * 依頼文を織り込む。requestText が無ければ従来の定型文をそのまま返す
 * （既存ナレーションの見た目は不変・AC-10）。
 */
function withRequestText(baseText: string, event: OfficeEvent): string {
  if (event.requestText === undefined) return baseText;
  return `${baseText}: ${truncateText(event.requestText)}`;
}

/**
 * 直近の OfficeEvent から実況テキストを 1 行組み立てる。イベントが無ければ
 * 静止時の定型文を返す。ボタン等の操作は一切生成しない（表示専用）。
 */
export function buildNarrationText(event: OfficeEvent | null): string {
  if (!event) return DEFAULT_NARRATION_TEXT;

  const who = subjectOf(event);

  if (event.type === "pre_tool") {
    return withRequestText(`${who} が ${event.toolName ?? DEFAULT_TOOL_LABEL} を実行しています`, event);
  }
  if (event.type === "post_tool") {
    return withRequestText(`${who} が ${event.toolName ?? DEFAULT_TOOL_LABEL} の結果を確認しています`, event);
  }
  return withRequestText(`${who} が ${EVENT_PHRASES[event.type]}`, event);
}
