// サイドバーのイベントログ（直近 7 件のリングバッファ・M1-4b）。
//
// OfficeState は集約済みセッション状態のみを保持し個々の生イベント履歴は
// 持たないため、SSE を受け取った page.tsx 側でこのバッファに push する。
// クラス自体は React に依存しない（apps/web/game と同じ「テスタブルなロジックは
// 分離する」方針を app 層にも適用）。
import type { OfficeEvent } from "@ai-office/protocol";
import { shortenSessionId } from "./format";

export const EVENT_LOG_CAPACITY = 7;

/** 直近 N 件（既定 7 件）を新しい順に保持するクライアント側リングバッファ。 */
export class EventLogBuffer {
  private readonly capacity: number;
  private items: OfficeEvent[] = [];

  constructor(capacity: number = EVENT_LOG_CAPACITY) {
    this.capacity = capacity;
  }

  push(event: OfficeEvent): void {
    this.items = [event, ...this.items].slice(0, this.capacity);
  }

  /** 新しい順の配列（呼び出し側が変更しても内部状態に影響しないコピー）。 */
  getItems(): OfficeEvent[] {
    return [...this.items];
  }
}

/**
 * イベントログ 1 行分の表示テキスト（時刻 + type + sessionId 短縮）。
 * 時刻は `event.ts`（注入済み）を UTC の HH:MM:SS で表す。ローカルタイムゾーンに
 * 依存すると実行環境ごとに結果が変わり決定論テストが書けないため、あえて UTC 固定。
 */
export function formatEventLogLine(event: OfficeEvent): string {
  const time = new Date(event.ts).toISOString().slice(11, 19);
  return `${time} ${event.type} ${shortenSessionId(event.sessionId)}`;
}
