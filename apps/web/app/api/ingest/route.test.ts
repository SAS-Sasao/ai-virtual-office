import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribe, type OfficeEventListener } from "../../../lib/bus";
import * as dbClient from "../../../db/client";
import * as dbEvents from "../../../db/events";
import { events } from "../../../db/schema";
import { getStats, resetStatsSingletonForTests } from "../../../lib/stats";
import { POST } from "./route";

function jsonRequest(body: unknown, rawBody?: string): Request {
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody ?? JSON.stringify(body),
  });
}

/**
 * lib/bus.ts はテストプロセス全体で共有される globalThis シングルトンのため、
 * 各テストで subscribe → 検証 → 必ず unsubscribe して購読リークを防ぐ。
 */
function collectPublished(): { received: unknown[]; unsubscribe: () => void } {
  const received: unknown[] = [];
  const listener: OfficeEventListener = (ev) => received.push(ev);
  const unsubscribe = subscribe(listener);
  return { received, unsubscribe };
}

describe("POST /api/ingest", () => {
  it("正規化済み OfficeEvent を受理し 200 + ignored:false を返し、bus に publish する", async () => {
    const { received, unsubscribe } = collectPublished();

    const event = { type: "session_start", sessionId: "s1", ts: 1_700_000_000_000 };
    const res = await POST(jsonRequest(event));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: false });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("生 hooks JSON（hook_event_name 形式）は受理しない（200 + ignored:true、publish されない）", async () => {
    const { received, unsubscribe } = collectPublished();

    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "session-abc",
      tool_name: "Edit",
      tool_input: { file_path: "/home/user/secret/App.tsx" },
    };
    const res = await POST(jsonRequest(raw));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(received).toHaveLength(0);
  });

  it("パース不能な JSON でも 200 + ignored:true を返す", async () => {
    const { received, unsubscribe } = collectPublished();

    const res = await POST(jsonRequest(undefined, "{not valid json"));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(received).toHaveLength(0);
  });

  it("未知フィールド入り OfficeEvent は受理されるが、publish されるオブジェクトから未知フィールドが strip される", async () => {
    const { received, unsubscribe } = collectPublished();

    const event = {
      type: "user_prompt",
      sessionId: "s1",
      ts: 1,
      prompt: "must be stripped before publish",
    };
    const res = await POST(jsonRequest(event));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: false });
    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty("prompt");
    expect(Object.keys(received[0] as object).sort()).toEqual(["sessionId", "ts", "type"]);
  });
});

/**
 * M1-2a からの繰り越し（#1）: ingest route の DB 結線を単体テストで担保する。
 * テストプロセス全体は `apps/web/vitest.config.ts` で `AI_OFFICE_DB_PATH=":memory:"`
 * に固定されているため、`getDb()`（引数なしの既定解決）はそのまま :memory: を
 * 使う。各テストの前後で `resetDbSingletonForTests()` を呼び、他テストの
 * insert 結果が漏れ込まないようにする（同一テストファイル内で globalThis
 * シングルトンが共有されるため）。
 */
describe("POST /api/ingest -> db persistence", () => {
  beforeEach(() => {
    dbClient.resetDbSingletonForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dbClient.resetDbSingletonForTests();
  });

  it("受理した OfficeEvent が events テーブルに1行保存され、各カラム値が一致する", async () => {
    const event = {
      type: "pre_tool",
      sessionId: "db-test-1",
      toolName: "Edit",
      fileBase: "App.tsx",
      ts: 1_700_000_000_123,
      seq: 7,
    };

    const res = await POST(jsonRequest(event));
    expect(res.status).toBe(200);

    const db = dbClient.getDb();
    expect(db).not.toBeNull();
    const rows = db!.select().from(events).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "pre_tool",
      sessionId: "db-test-1",
      toolName: "Edit",
      fileBase: "App.tsx",
      subagentType: null,
      ts: 1_700_000_000_123,
      seq: 7,
    });
    expect(typeof rows[0].receivedAt).toBe("number");
  });

  it("db が null（getDb が null を返す）でも 200 + publish は維持され、永続化だけがスキップされる", async () => {
    const { received, unsubscribe } = collectPublished();
    const getDbSpy = vi.spyOn(dbClient, "getDb").mockReturnValue(null);

    const event = { type: "session_start", sessionId: "db-null-test", ts: 1 };
    const res = await POST(jsonRequest(event));

    unsubscribe();

    expect(getDbSpy).toHaveBeenCalled();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: false });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("insertEvent が例外を投げても 200 + publish は維持され、警告ログのみで握り潰される", async () => {
    const { received, unsubscribe } = collectPublished();
    const insertSpy = vi.spyOn(dbEvents, "insertEvent").mockImplementation(() => {
      throw new Error("boom: simulated insert failure");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const event = { type: "session_start", sessionId: "insert-throw-test", ts: 2 };
    const res = await POST(jsonRequest(event));

    unsubscribe();

    expect(insertSpy).toHaveBeenCalled();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: false });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
    expect(warnSpy).toHaveBeenCalled();
  });
});

/**
 * バックエンド堅牢化サイクル2「修正A（#3 ingest silent-drops の観測可能化）」。
 * AC-1 / AC-2 / AC-3。既存 L156-174 の DB 失敗 warn パターンを踏襲しつつ、
 * NFR-4（機微情報の多層防御）としてログに生の err オブジェクト・err.message・
 * body の値を一切含めないことを assert する。
 */
describe("POST /api/ingest -> observability（構造化ログ + stats カウンタ、AC-1/AC-2/AC-3）", () => {
  beforeEach(() => {
    resetStatsSingletonForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetStatsSingletonForTests();
  });

  it("AC-1: schema 不一致は安定プレフィックスの構造化ログを出し、フィールド値を一切含めない（200 + ignored:true 維持）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { received, unsubscribe } = collectPublished();

    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "must-not-leak-into-log",
      tool_name: "Edit",
    };
    const res = await POST(jsonRequest(raw));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(received).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0];
    expect(call).toEqual(["web: ingest dropped invalid event (schema)"]);
    expect(JSON.stringify(call)).not.toContain("must-not-leak-into-log");
    expect(JSON.stringify(call)).not.toContain("PreToolUse");

    expect(getStats().snapshot().dropped.schema).toBe(1);
  });

  it("AC-2: パース不能ボディは安定プレフィックス + err.name のみのログを出す（生 err/err.message/body を含めない・200 維持）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { received, unsubscribe } = collectPublished();
    const secretBodyFragment = "must-not-leak-body-fragment";

    const res = await POST(jsonRequest(undefined, `{${secretBodyFragment}`));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(received).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0];
    // ログ引数は「安定プレフィックス + err.name」の単一文字列のみで、生の err
    // オブジェクトや err.message、不正な body の断片を一切含まない（NFR-4）。
    expect(call).toEqual(["web: ingest dropped unparseable body (SyntaxError)"]);
    expect(call).toHaveLength(1);
    expect(JSON.stringify(call)).not.toContain(secretBodyFragment);

    expect(getStats().snapshot().dropped.unparseable).toBe(1);
  });

  it("AC-3: 正常受理は accepted をカウントする", async () => {
    const { unsubscribe } = collectPublished();

    const event = { type: "session_start", sessionId: "stats-accept-1", ts: 1 };
    const res = await POST(jsonRequest(event));

    unsubscribe();

    expect(res.status).toBe(200);
    expect(getStats().snapshot().acceptedCount).toBe(1);
    expect(getStats().snapshot().droppedCount).toBe(0);
  });

  it("schema 不一致・パース不能を混在させても、dropped の理由別カウントがそれぞれ正しく積み上がる", async () => {
    const { unsubscribe } = collectPublished();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await POST(jsonRequest({ hook_event_name: "PreToolUse" }));
    await POST(jsonRequest(undefined, "{not valid json"));
    await POST(jsonRequest({ type: "session_start", sessionId: "mixed-1", ts: 1 }));

    unsubscribe();

    const snap = getStats().snapshot();
    expect(snap.dropped).toEqual({ schema: 1, unparseable: 1 });
    expect(snap.droppedCount).toBe(2);
    expect(snap.acceptedCount).toBe(1);
  });
});
