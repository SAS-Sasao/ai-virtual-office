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
