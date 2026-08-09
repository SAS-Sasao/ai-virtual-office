// サイドバーのイベントログ（直近 7 件のリングバッファ・M1-4b）。
//
// OfficeState は集約済みセッション状態のみを保持し個々の生イベント履歴は
// 持たないため、SSE を受け取った page.tsx 側でこのバッファに push する。
// クラス自体は React に依存しない（apps/web/game と同じ「テスタブルなロジックは
// 分離する」方針を app 層にも適用）。
import type { OfficeEvent } from "@ai-office/protocol";
import { shortenSessionId } from "./format";

export const EVENT_LOG_CAPACITY = 7;

/**
 * dedup 用に「直近 identity」を追跡するセッション数の上限（メモリ backstop）。
 * `loadRecentSessions`（db/events.ts）が返す restore は latest-per-session
 * （10 分窓内の active セッションのみ）なので実運用でこの上限に達することは
 * 想定していない。上限超過時は最も古く登録したセッションを FIFO で 1 件
 * evict する（バックエンド堅牢化サイクル2「修正D」rev.2）。
 */
export const EVENT_LOG_SESSION_TRACK_LIMIT = 512;

/**
 * `push()` の重複判定に使う identity キーを組み立てる。
 * `seq` があれば `${sessionId}#${seq}`、無ければ `${sessionId}#${ts}#${type}`
 * （protocol の順序規約どおり、seq を優先し無ければ ts+type で近似する）。
 */
function identityOf(event: OfficeEvent): string {
  if (event.seq !== undefined) {
    return `${event.sessionId}#${event.seq}`;
  }
  return `${event.sessionId}#${event.ts}#${event.type}`;
}

/** 直近 N 件（既定 7 件）を新しい順に保持するクライアント側リングバッファ。 */
export class EventLogBuffer {
  private readonly capacity: number;
  private items: OfficeEvent[] = [];
  // per-session の直近 identity（Map は挿入順を保持するため FIFO evict に使える）。
  // 固定容量リング（旧 seen=64）ではなく sessionId をキーにすることで、
  // 同時セッション数に依存せず restore の latest-per-session 再送を確実に
  // 弾ける（バックエンド堅牢化サイクル2「修正D」rev.2 review finding 1 対応）。
  private readonly lastIdentityBySession = new Map<string, string>();

  constructor(capacity: number = EVENT_LOG_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * イベントを追加する。同一セッションの直近 identity と一致する（= 再接続時の
   * restore 再送などによる重複）場合は何もせず `false` を返す。新規なら追加し
   * `true` を返す（既存呼び出し側は戻り値を無視できる後方互換な拡張）。
   */
  push(event: OfficeEvent): boolean {
    const identity = identityOf(event);
    if (this.lastIdentityBySession.get(event.sessionId) === identity) {
      return false;
    }

    if (
      !this.lastIdentityBySession.has(event.sessionId) &&
      this.lastIdentityBySession.size >= EVENT_LOG_SESSION_TRACK_LIMIT
    ) {
      const oldestSessionId = this.lastIdentityBySession.keys().next().value;
      if (oldestSessionId !== undefined) {
        this.lastIdentityBySession.delete(oldestSessionId);
      }
    }
    this.lastIdentityBySession.set(event.sessionId, identity);

    this.items = [event, ...this.items].slice(0, this.capacity);
    return true;
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
