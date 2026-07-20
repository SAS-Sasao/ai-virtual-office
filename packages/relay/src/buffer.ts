import type { OfficeEvent } from "@ai-office/protocol";
import type { Forwarder } from "./forward.js";

/**
 * タイマーの DI ポイント。本番既定は `setTimeout` をラップしたもの。
 * テストは手動 tick（`fn()` を明示的に呼ぶ）で駆動し、実時間 sleep を使わない。
 *
 * `fn` の型は `() => void` だが、実装は内部で async 関数を渡すことがある
 * （`setTimeout` はいずれにせよ戻り値を無視するため本番挙動に影響しない）。
 * テストダブルはこれを利用し、`fn()` の戻り値を await してから次のアサーションに
 * 進むことで、決定論的にドレインの完了を待つことができる。
 */
export type ScheduleTimer = (fn: () => void, ms: number) => void;

export interface CreateRetryBufferOptions {
  /** 実際の転送を行う関数（成否を boolean で返す）。 */
  forward: Forwarder;
  /** バッファの最大保持件数（既定 1000）。超過時は最古を破棄する。 */
  maxSize?: number;
  /** 再送の初回待機時間（ms、既定 100）。 */
  initialDelayMs?: number;
  /** 再送待機時間の上限（ms、既定 30000）。 */
  maxDelayMs?: number;
  /** タイマーの DI（既定は実 `setTimeout`）。 */
  scheduleTimer?: ScheduleTimer;
}

export interface RetryBuffer {
  /**
   * 常に直送（`forward`）を試みる。成功すればそれで完了。失敗した場合のみ
   * バッファへ enqueue し、再送スケジュールを（未予約なら）開始する。
   * バッファが非空でも新規イベントを待たせない（head-of-line ブロッキングを
   * 採らない設計判断。順序保証は消費側の順序防御に一本化する）。
   *
   * 失敗時も throw しない（NFR-2 は forward 側で担保済みだが、呼び出し側の
   * server.ts が期待する契約 = 「呼べば必ず解決する」を維持する）。
   */
  send: (event: OfficeEvent) => Promise<void>;
  /** 現在バッファに滞留している件数（テスト・観測用）。 */
  size: () => number;
}

const defaultScheduleTimer: ScheduleTimer = (fn, ms) => {
  setTimeout(fn, ms);
};

/**
 * forward 失敗時にイベントを保持し、指数バックオフで再送するバッファを生成する。
 *
 * 設計判断（M1-2a 設計メモ rev.3 N-2 対応・人間承認済み）: head-of-line
 * ブロッキングは採らない。NFR-1（1 秒以内の反映）を守るため新規イベントは
 * 常に直送を試み、順序保証は消費側（office-state の順序防御）に一本化する。
 */
export function createRetryBuffer(options: CreateRetryBufferOptions): RetryBuffer {
  const {
    forward,
    maxSize = 1000,
    initialDelayMs = 100,
    maxDelayMs = 30000,
    scheduleTimer = defaultScheduleTimer,
  } = options;

  const queue: OfficeEvent[] = [];
  let currentDelayMs = initialDelayMs;
  let retryScheduled = false;
  // Phase 3 レビュー medium finding 対応: scheduleRetry のタイマー callback は
  // drain() を await する前に retryScheduled = false を立てるため、drain が
  // forward を await 中に新規 send() が失敗すると、その enqueue が
  // retryScheduled=false を見て 2 本目のタイマーを予約してしまう。両方の
  // タイマーが発火すると drain() が並行起動し、同じ queue[0] を二重に
  // forward しうる（実害: 重複転送）。draining フラグで drain() 自体を
  // 排他し、再入時は即座に return することで防ぐ。
  let draining = false;

  function scheduleRetry(): void {
    if (retryScheduled) {
      return;
    }
    retryScheduled = true;
    scheduleTimer(async () => {
      retryScheduled = false;
      await drain();
    }, currentDelayMs);
  }

  function enqueue(event: OfficeEvent): void {
    queue.push(event);
    if (queue.length > maxSize) {
      const overflow = queue.length - maxSize;
      queue.splice(0, overflow);
      console.warn(
        `relay: retry buffer exceeded maxSize=${maxSize}; dropped ${overflow} oldest buffered event(s)`,
      );
    }
    scheduleRetry();
  }

  // バッファが空になるまで順次ドレインする（1 件/tick にしない）。失敗したら
  // 指数バックオフで再スケジュールし、成功が続く限り即座に次のイベントへ進む。
  //
  // draining フラグで排他する: 既に別の drain() 実行が進行中（forward の
  // 応答を await 中）であれば、この呼び出しは何もせず即座に return する。
  // これにより、進行中の drain が forward を await している間に enqueue
  // 経由でもう一本タイマーが予約され、それが先に発火しても、同じ
  // queue[0] を二重に forward することはない。
  async function drain(): Promise<void> {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (queue.length > 0) {
        const event = queue[0];
        const ok = await forward(event);
        if (ok) {
          queue.shift();
          currentDelayMs = initialDelayMs;
          continue;
        }
        currentDelayMs = Math.min(currentDelayMs * 2, maxDelayMs);
        scheduleRetry();
        return;
      }
    } finally {
      draining = false;
    }
  }

  async function send(event: OfficeEvent): Promise<void> {
    const ok = await forward(event);
    if (!ok) {
      enqueue(event);
    }
  }

  return {
    send,
    size: () => queue.length,
  };
}
