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
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

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
          // controller が既に閉じている等の場合は配信をスキップする。
        }
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // 同上。
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
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
