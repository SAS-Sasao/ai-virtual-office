// セッション一覧・待ちパネルの「経過」表示（M1-4b 設計メモ「経過時間の扱い」）。
// 時刻は必ず引数として注入する（内部で Date.now() を呼ばない。apps/web/game の
// 決定論方針と同じ理由 — テストの決定論性と、10 秒間隔の低頻度 re-render に
// 委ねるための純関数化）。

/**
 * `nowMs - sinceMs` を「分:秒」（M:SS、秒は 2 桁ゼロ埋め）で表す。
 * 負の差分（クロックスキュー・古いスナップショット由来）は 0:00 にクランプする。
 */
export function formatElapsed(nowMs: number, sinceMs: number): string {
  const diff = Math.max(0, nowMs - sinceMs);
  const minutes = Math.floor(diff / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
