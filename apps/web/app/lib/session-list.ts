// サイドバーのセッション一覧・待ちパネル整形（M1-4b）。
// OfficeState.getSnapshot().sessions（SessionCharacter[]）を表示用の行データへ
// 変換する純関数群。React state に持たせるのは `buildSessionListRows` /
// `buildWaitingRows` の戻り値（低頻度スナップショット）のみで、経過時間の
// 「今」は呼び出し側が注入する（elapsed.ts と同じ決定論方針）。
import type { CharacterState } from "@ai-office/protocol";
import type { SessionCharacter } from "../../game/office-state";
import { formatElapsed } from "./elapsed";
import { shortenSessionId, truncateText } from "./format";

const UNKNOWN_LABEL = "不明";

export interface SessionListRow {
  sessionId: string;
  shortId: string;
  role: string;
  dept: string;
  org: string;
  state: CharacterState;
  elapsed: string;
  /**
   * 現在着手中の作業依頼（短縮表示用、ADR-007 (b)-1 AC-9）。
   * `SessionCharacter.requestText` が無いセッションは undefined。
   */
  requestText?: string;
}

function toRow(session: SessionCharacter, nowMs: number): SessionListRow {
  return {
    sessionId: session.sessionId,
    shortId: shortenSessionId(session.sessionId),
    role: session.role ?? UNKNOWN_LABEL,
    dept: session.dept ?? UNKNOWN_LABEL,
    org: session.org ?? "",
    state: session.state,
    elapsed: formatElapsed(nowMs, session.lastTs),
    requestText: session.requestText !== undefined ? truncateText(session.requestText) : undefined,
  };
}

/** セッション一覧（直近更新順）。 */
export function buildSessionListRows(sessions: readonly SessionCharacter[], nowMs: number): SessionListRow[] {
  return [...sessions].sort((a, b) => b.lastTs - a.lastTs).map((s) => toRow(s, nowMs));
}

/**
 * 待ちパネル用の一覧（state === "waiting" のみ）。件数は `countWaiting` と
 * 常に同じ述語から導出されるため乖離しない（M1-4b AC-5）。
 */
export function buildWaitingRows(sessions: readonly SessionCharacter[], nowMs: number): SessionListRow[] {
  return buildSessionListRows(
    sessions.filter((s) => s.state === "waiting"),
    nowMs,
  );
}

/** 許可待ちバッジの件数。`buildWaitingRows` と同じ述語（state === "waiting"）を使う。 */
export function countWaiting(sessions: readonly SessionCharacter[]): number {
  return sessions.filter((s) => s.state === "waiting").length;
}
