import { Hono } from "hono";
import { OfficeEventSchema, type OfficeEvent } from "@ai-office/protocol";
import { normalizeHookEvent } from "./normalize.js";
import { createSeqCounter } from "./seq.js";

/**
 * 正規化済み OfficeEvent を下流（web の /api/ingest、または再送バッファ）へ
 * 引き渡す関数。server 層は成否を気にしない（成否判定・再送は
 * src/buffer.ts の RetryBuffer#send の責務）。呼べば必ず解決することを期待する
 * 契約であり、実運用では cli.ts が RetryBuffer#send をここに注入する。
 * 独自実装が万一 throw しても /hooks ハンドラ側で保険の try/catch を行う（NFR-2）。
 */
export type EventSink = (event: OfficeEvent) => Promise<void>;

/**
 * `/hooks/:event` で受理する既知のパス（アーキ設計 §6.1 の hooks イベント設計）。
 * :event パスパラメータはルーティング用の識別子に過ぎず、正規化そのものは
 * 常に body の hook_event_name を使って行う（normalizeHookEvent の既存ロジックを
 * 変えない）。未知の :event は 200 + ignored:true として黙って無視する。
 */
const HOOK_EVENT_SLUGS = new Set([
  "session-start",
  "user-prompt",
  "pre-tool",
  "post-tool",
  "notification",
  "stop",
  "subagent-stop",
  "session-end",
]);

export interface CreateServerOptions {
  /** 正規化済み OfficeEvent を web の /api/ingest 等へ転送する関数（DI）。 */
  forward: EventSink;
  /** 現在時刻を返す関数（DI、テストの決定論性のため既定は Date.now）。 */
  now?: () => number;
  /**
   * seq 採番関数（DI、既定は 0 起点の createSeqCounter）。永続採番
   * （createPersistentSeqCounter）は読み書き失敗時に `undefined` を返し得る。
   * その場合はイベントに seq を付与しない（消費側は ts 昇順にフォールバックする）。
   */
  nextSeq?: () => number | undefined;
  /** true のとき /test/inject を有効化する（既定 false）。 */
  testMode?: boolean;
  /** GET /health が返す version 文字列。 */
  version?: string;
  /** GET /health が返す port を取得する関数。--port 0 で実ポートが後から確定するため関数注入。 */
  getPort?: () => number;
}

/**
 * hooks の唯一の宛先となる Hono アプリを構築する。依存はすべて DI であり、
 * サーバ自体は起動しない（起動は cli.ts の責務）。
 */
export function createServer(options: CreateServerOptions): Hono {
  const {
    forward,
    now = () => Date.now(),
    nextSeq = createSeqCounter(),
    testMode = false,
    version = "0.0.0",
    getPort = () => 0,
  } = options;

  const app = new Hono();

  // NFR-2: hooks はいかなる場合も Claude Code の動作をブロックしてはならない。
  // このハンドラは JSON parse 失敗・未知イベント・normalize 失敗・forward 失敗の
  // いずれの経路でも例外を投げず、常に 200 を返す。
  app.post("/hooks/:event", async (c) => {
    const slug = c.req.param("event");
    if (!HOOK_EVENT_SLUGS.has(slug)) {
      return c.json({ ok: true, ignored: true });
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: true, ignored: true });
    }

    const normalized = normalizeHookEvent(raw, now());
    if (!normalized) {
      return c.json({ ok: true, ignored: true });
    }

    const event: OfficeEvent = { ...normalized, seq: nextSeq() };

    try {
      await forward(event);
    } catch (err) {
      // forward（createForwarder）は仕様上すでに失敗を自前で握り潰すが、
      // 呼び出し側が独自実装を注入した場合の保険として二重に握り潰す（NFR-2）。
      console.warn("relay: forward threw unexpectedly (ignored, hooks must never block)", err);
    }

    return c.json({ ok: true, ignored: false });
  });

  // AI_OFFICE_TEST_MODE=1 のときのみ有効。fixture 注入用の受け口であり、
  // 無検証の pass-through は作らない（必ず OfficeEventSchema を通す）。
  app.post("/test/inject", async (c) => {
    if (!testMode) {
      return c.notFound();
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, accepted: 0, error: "invalid JSON body" }, 400);
    }

    if (!Array.isArray(body)) {
      return c.json(
        { ok: false, accepted: 0, error: "body must be an array of OfficeEvent" },
        400,
      );
    }

    // 1 件ずつ検証し、1 件でも不正なら何も forward しない（部分適用しない）。
    const validated: OfficeEvent[] = [];
    for (const item of body) {
      const result = OfficeEventSchema.safeParse(item);
      if (!result.success) {
        return c.json({ ok: false, accepted: 0, error: result.error.message }, 400);
      }
      validated.push(result.data);
    }

    for (const event of validated) {
      try {
        await forward(event);
      } catch (err) {
        console.warn("relay: forward threw unexpectedly during /test/inject (ignored)", err);
      }
    }

    return c.json({ ok: true, accepted: validated.length });
  });

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      version,
      testMode,
      pid: process.pid,
      port: getPort(),
    });
  });

  return app;
}
