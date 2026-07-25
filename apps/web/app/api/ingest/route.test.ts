import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribe, type OfficeEventListener } from "../../../lib/bus";
import * as dbClient from "../../../db/client";
import * as dbEvents from "../../../db/events";
import { events } from "../../../db/schema";
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
