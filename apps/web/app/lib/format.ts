// UI 表示専用のテキスト整形ヘルパー（M1-4b）。React 非依存の純関数のみを置く
// （apps/web/game/ 同様のテスタビリティ方針を app 層のロジックにも適用する）。

const DEFAULT_LENGTH = 8;

/**
 * セッション一覧・イベントログ・ナレーションバーで使う短縮 sessionId。
 * 既定 8 文字まで（それ以下ならそのまま）。
 */
export function shortenSessionId(sessionId: string, length: number = DEFAULT_LENGTH): string {
  return sessionId.length <= length ? sessionId : sessionId.slice(0, length);
}

const DEFAULT_TRUNCATE_LENGTH = 40;
const ELLIPSIS = "…";

/**
 * 作業依頼本文（requestText, ADR-007 (b)-1）等の長いテキストを UI 表示用に
 * 短縮する。既定 40 文字まで（それ以下ならそのまま）。超える場合は指定長で
 * 切り詰めて末尾に "…" を付す。session-list / narration の両方から使う
 * 共通ヘルパー（表示専用・純関数）。
 */
export function truncateText(text: string, length: number = DEFAULT_TRUNCATE_LENGTH): string {
  return text.length <= length ? text : `${text.slice(0, length)}${ELLIPSIS}`;
}
