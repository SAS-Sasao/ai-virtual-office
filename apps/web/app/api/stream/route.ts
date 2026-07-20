import { subscribe } from "../../../lib/bus";
import type { OfficeEvent } from "@ai-office/protocol";

// SSE はレスポンスをバッファリングさせず即時ストリーミングする必要があるため、
// このルートは常に動的（force-dynamic）とする。
export const dynamic = "force-dynamic";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * オフィスイベントを Server-Sent Events で配信するエンドポイント。
 * 接続開始時に `hello` イベントを送出し、以後は bus.subscribe で受信した
 * OfficeEvent を逐次配信する。15 秒ごとに heartbeat（コメント行）を送り、
 * 中間プロキシ等によるコネクションの切断を防ぐ。
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: hello\ndata: {}\n\n"));

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
