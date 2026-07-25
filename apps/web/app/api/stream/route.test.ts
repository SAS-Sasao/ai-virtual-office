import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { publish } from "../../../lib/bus";
import * as dbClient from "../../../db/client";
import { insertEvent } from "../../../db/events";
import { GET } from "./route";

/**
 * M1-2a からの繰り越し（#2）: stream route の回帰テスト。
 *
 * `GET()` は本文に `await` を一切含まないため、呼び出しは同期的に完了する
 * （`ReadableStream` の `start()` は構築時に同期実行される）。したがって
 * `await GET()` が返ってきた時点で、hello の enqueue → restore の読み込み・
 * enqueue → `subscribe()` までが既に完了している。この性質を使い、
 * `GET()` の直後（同期的に）`publish()` した live イベントが restore より
 * 後の frame としてのみ観測されることで、hello → restore → subscribe という
 * 実装コメントどおりの順序を固定する。
 *
 * ReadableStream の消費はテスト内で `getReader()` + `reader.cancel()` により
 * 完結させ、実サーバ起動や `sleep` は使わない（heartbeat の setInterval は
 * `cancel()` で route.ts 側が確実に片付ける）。
 */

async function readFrames(res: Response, count: number): Promise<string[]> {
  const body = res.body;
  if (!body) throw new Error("expected a body on the SSE response");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: string[] = [];

  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1 && frames.length < count) {
      frames.push(buf.slice(0, idx + 2));
      buf = buf.slice(idx + 2);
    }
  }

  await reader.cancel();
  return frames;
}

function parseDataFrame(frame: string, eventPrefix: string): unknown {
  return JSON.parse(frame.slice(eventPrefix.length).trim());
}

describe("GET /api/stream", () => {
  beforeEach(() => {
    dbClient.resetDbSingletonForTests();
  });

  afterEach(() => {
    dbClient.resetDbSingletonForTests();
  });

  it("event: restore が1件1イベントで送出される（配列にまとめない、SSE フレーム形式）", async () => {
    const db = dbClient.getDb();
    expect(db).not.toBeNull();
    insertEvent(db!, { type: "session_start", sessionId: "restore-s1", ts: Date.now() });
    insertEvent(db!, { type: "session_start", sessionId: "restore-s2", ts: Date.now() });

    const res = await GET();
    const frames = await readFrames(res, 3); // hello + restore x2

    expect(frames[0]).toBe("event: hello\ndata: {}\n\n");

    const restoreFrames = frames.slice(1);
    expect(restoreFrames).toHaveLength(2);
    for (const frame of restoreFrames) {
      expect(frame.startsWith("event: restore\ndata: ")).toBe(true);
      const parsed = parseDataFrame(frame, "event: restore\ndata: ");
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).toHaveProperty("sessionId");
    }

    const sessionIds = restoreFrames
      .map((f) => parseDataFrame(f, "event: restore\ndata: ") as OfficeEvent)
      .map((ev) => ev.sessionId)
      .sort();
    expect(sessionIds).toEqual(["restore-s1", "restore-s2"]);
  });

  it("hello の後・bus subscribe の前に restore を送出する（subscribe 後に publish したイベントは restore より後にのみ届く）", async () => {
    const db = dbClient.getDb();
    expect(db).not.toBeNull();
    insertEvent(db!, { type: "session_start", sessionId: "order-s1", ts: Date.now() });

    const res = await GET();
    // GET() は内部に await を含まないため、ここに戻った時点で hello enqueue →
    // restore enqueue → subscribe() までは既に同期的に完了している。
    // この直後に publish すれば、それは restore の後ろにのみ現れるはずである。
    const liveEvent: OfficeEvent = { type: "pre_tool", sessionId: "live-1", toolName: "Edit", ts: Date.now() };
    publish(liveEvent);

    const frames = await readFrames(res, 3); // hello, restore(order-s1), live(live-1)

    expect(frames[0]).toBe("event: hello\ndata: {}\n\n");

    expect(frames[1].startsWith("event: restore\ndata: ")).toBe(true);
    const restored = parseDataFrame(frames[1], "event: restore\ndata: ") as OfficeEvent;
    expect(restored.sessionId).toBe("order-s1");

    // live 配信フレームは "event:" 行を持たない（route.ts の bus 購読コールバック参照）。
    expect(frames[2].startsWith("event:")).toBe(false);
    expect(frames[2].startsWith("data: ")).toBe(true);
    const live = parseDataFrame(frames[2], "data: ") as OfficeEvent;
    expect(live.sessionId).toBe("live-1");
  });

  it("DB が空でも restore フレームを送出せず、hello の直後に live 配信へ移る", async () => {
    dbClient.getDb(); // シングルトンを確立するのみ（何も insert しない）

    const res = await GET();
    const liveEvent: OfficeEvent = { type: "session_start", sessionId: "live-only", ts: Date.now() };
    publish(liveEvent);

    const frames = await readFrames(res, 2); // hello, live のみ（restore 無し）

    expect(frames[0]).toBe("event: hello\ndata: {}\n\n");
    expect(frames[1].startsWith("event: restore")).toBe(false);
    const live = parseDataFrame(frames[1], "data: ") as OfficeEvent;
    expect(live.sessionId).toBe("live-only");
  });
});
