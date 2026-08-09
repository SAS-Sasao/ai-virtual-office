import { subscribe } from "../../../lib/bus";
import type { OfficeEvent } from "@ai-office/protocol";
import { getDb } from "../../../db/client";
import { loadRecentSessions } from "../../../db/events";

// SSE はレスポンスをバッファリングさせず即時ストリーミングする必要があるため、
// このルートは常に動的（force-dynamic）とする。
export const dynamic = "force-dynamic";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * オフィスイベントを Server-Sent Events で配信するエンドポイント。
 * 接続開始時に `hello` イベントを送出し、続けて直近の永続化状態を
 * `event: restore`（1 件 1 イベントを N 回、配列にはしない）で配信してから、
 * bus.subscribe による live 配信へ移る。better-sqlite3 は同期 API のため、
 * subscribe 前に読み切ることで restore と live の間に取りこぼしは生じない。
 * DB が使えない場合（getDb が null、または読み取り失敗）は restore を
 * スキップするだけで、live 配信自体は継続する（NFR-2 と同じ「永続化は
 * 付加価値」思想）。15 秒ごとに heartbeat（コメント行）を送り、中間プロキシ
 * 等によるコネクションの切断を防ぐ。
 *
 * バックエンド堅牢化サイクル2「修正C」(AC-5): 購読解除（unsubscribe）・
 * heartbeat の後始末は `cleanup()` に一本化し、①ReadableStream の `cancel()`
 * ②ライブ/heartbeat の enqueue 失敗時（クライアントが既に消えている状況）
 * ③`request.signal` の abort（`cancel()` が呼ばれない環境向けのフォールバック）
 * の3経路すべてから同じ関数を呼ぶ。`cleanup()` は unsubscribe/heartbeat を
 * null 化してから解除するため、複数回呼ばれても安全（冪等）。
 *
 * Phase 3 レビュー finding 対応: `cleanup()` は自身が ③で張った
 * `request.signal` の abort リスナーも `removeEventListener` で確実に畳む
 * （自己完結）。`removeEventListener` は未登録・二重呼びでも no-op のため、
 * 追加のガード変数は不要。
 */
export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const cleanup = (): void => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    request.signal.removeEventListener("abort", cleanup);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: hello\ndata: {}\n\n"));

      try {
        const db = getDb();
        if (db) {
          const restoreEvents = loadRecentSessions(db, Date.now());
          for (const ev of restoreEvents) {
            controller.enqueue(encoder.encode(`event: restore\ndata: ${JSON.stringify(ev)}\n\n`));
          }
        }
      } catch (err) {
        console.warn("web: failed to load restore events (continuing without restore)", err);
      }

      unsubscribe = subscribe((ev: OfficeEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // controller が既に閉じている＝クライアントは消えている。配信を
          // スキップするだけでなく、取りこぼした購読・タイマーを片付ける。
          cleanup();
        }
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // 同上。
          cleanup();
        }
      }, HEARTBEAT_INTERVAL_MS);

      // `cancel()`（reader.cancel() 由来）が呼ばれない環境（runtime によっては
      // ReadableStream の cancel が届かないケースがある）に備え、
      // `request.signal` の abort からも直接 cleanup を発火させる。
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
