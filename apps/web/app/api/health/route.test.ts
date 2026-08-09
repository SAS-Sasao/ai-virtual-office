import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "../../../db/client";
import { getStats, resetStatsSingletonForTests } from "../../../lib/stats";
import { GET } from "./route";

/**
 * バックエンド堅牢化サイクル2「修正B」(AC-4)。stats.snapshot() + db 状態を
 * 返す観測面の回帰テスト。実 DB を触らないよう既存の
 * `AI_OFFICE_DB_PATH=:memory:`（vitest.config.ts）+ `resetDbSingletonForTests()`
 * seam を使う。
 */
describe("GET /api/health", () => {
  beforeEach(() => {
    dbClient.resetDbSingletonForTests();
    resetStatsSingletonForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dbClient.resetDbSingletonForTests();
    resetStatsSingletonForTests();
  });

  it("accepted/dropped カウンタと db:\"up\" を 200 で返す", async () => {
    getStats().recordAccepted();
    getStats().recordAccepted();
    getStats().recordDropped("schema");

    dbClient.getDb(); // :memory: 接続を確立し db が "up" になる状態を作る

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      acceptedCount: 2,
      droppedCount: 1,
      dropped: { schema: 1, unparseable: 0 },
      db: "up",
    });
  });

  it("getDb() が null を返す場合は db:\"down\" を返す（例外を投げない）", async () => {
    vi.spyOn(dbClient, "getDb").mockReturnValue(null);

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.db).toBe("down");
  });

  it("カウンタが未使用（全て 0）でも 200 で返す", async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ acceptedCount: 0, droppedCount: 0, dropped: { schema: 0, unparseable: 0 } });
  });

  it("機微情報を含まない（accepted/dropped/db の件数・状態のみを返す）", async () => {
    const res = await GET();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["acceptedCount", "db", "dropped", "droppedCount"]);
  });
});
