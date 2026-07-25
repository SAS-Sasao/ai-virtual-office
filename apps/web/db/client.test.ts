import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, getDb, resetDbSingletonForTests, resolveDbPath } from "./client";
import { events } from "./schema";
import { insertEvent } from "./events";

describe("resolveDbPath", () => {
  it("uses AI_OFFICE_DB_PATH when set", () => {
    const path = resolveDbPath({ AI_OFFICE_DB_PATH: "/custom/dir/events.db" } as unknown as NodeJS.ProcessEnv);
    expect(path).toBe("/custom/dir/events.db");
  });

  it("falls back to ~/.ai-office/events.db when AI_OFFICE_DB_PATH is unset", () => {
    const path = resolveDbPath({} as unknown as NodeJS.ProcessEnv);
    expect(path.endsWith(join(".ai-office", "events.db"))).toBe(true);
    expect(path).not.toBe(join(".ai-office", "events.db"));
  });
});

describe("createDb", () => {
  it("returns a usable Db for :memory: (never touches disk)", () => {
    const db = createDb(":memory:");
    expect(db).not.toBeNull();
  });

  it("initializes the events table (CREATE TABLE IF NOT EXISTS) so it is queryable immediately", () => {
    const db = createDb(":memory:");
    expect(db).not.toBeNull();
    expect(() => db?.select().from(events).all()).not.toThrow();
    expect(db?.select().from(events).all()).toEqual([]);
  });

  it("returns null (does not throw) when the path cannot be initialized", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-test-"));
    const blockerFile = join(dir, "blocker"); // a *file*, not a directory
    writeFileSync(blockerFile, "not a directory");
    const impossiblePath = join(blockerFile, "sub", "events.db"); // mkdir under a file -> ENOTDIR

    expect(() => createDb(impossiblePath)).not.toThrow();
    expect(createDb(impossiblePath)).toBeNull();
  });
});

/**
 * M1-2a からの繰り越し（#3）: `getDb()` 初回接続時に一度だけ走る 30 日 prune
 * （要件 §7）の統合テスト。`createDb()` は生の better-sqlite3 ハンドルを外部に
 * 公開していないため、「別プロセスが書き込んだファイルを開く」形の検証はできない。
 * その代わり、`getDb(path)` は `path` を DI 可能なので、同一プロセス内で
 * 1) `getDb(path)` で最初の接続を確立して古い行・新しい行を insert する
 * 2) `resetDbSingletonForTests()` でシングルトンを破棄する
 * 3) 再度 `getDb(path)` で同じファイルを開き直す（＝プロセス内で「最初に接続を
 *    確立した」瞬間を再現し、prune を走らせる）
 * という流れで、ファイル DB に対する prune-on-init を再現する。
 */
describe("getDb() の初回接続時 30 日 prune", () => {
  it("ファイル DB を再オープンすると 31 日以上前の行だけが削除され、新しい行は残る", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-prune-test-"));
    const dbPath = join(dir, "events.db");
    resetDbSingletonForTests();

    try {
      const now = Date.now();
      const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

      // 1) seed: 最初の接続（この時点では空の新規ファイルなので prune 対象なし）
      const seedDb = getDb(dbPath);
      expect(seedDb).not.toBeNull();
      insertEvent(seedDb!, { type: "session_start", sessionId: "old", ts: now - THIRTY_ONE_DAYS_MS });
      insertEvent(seedDb!, { type: "session_start", sessionId: "fresh", ts: now });

      const seededRows = seedDb!.select().from(events).all();
      expect(seededRows).toHaveLength(2);

      // 2) シングルトンをリセットし、3) 同じファイルへ再接続する。
      //    これが「プロセス内で最初に接続を確立したタイミング」を再現し、
      //    pruneOlderThan(30日) が実行される。
      resetDbSingletonForTests();
      const reopened = getDb(dbPath);
      expect(reopened).not.toBeNull();

      const rows = reopened!.select().from(events).all();
      expect(rows.map((r) => r.sessionId).sort()).toEqual(["fresh"]);
    } finally {
      resetDbSingletonForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("31 日以内の行しか無ければ、再接続しても何も削除されない", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-prune-test-"));
    const dbPath = join(dir, "events.db");
    resetDbSingletonForTests();

    try {
      const now = Date.now();

      const seedDb = getDb(dbPath);
      expect(seedDb).not.toBeNull();
      insertEvent(seedDb!, { type: "session_start", sessionId: "fresh1", ts: now - 1000 });
      insertEvent(seedDb!, { type: "session_start", sessionId: "fresh2", ts: now });

      resetDbSingletonForTests();
      const reopened = getDb(dbPath);
      expect(reopened).not.toBeNull();

      const rows = reopened!.select().from(events).all();
      expect(rows.map((r) => r.sessionId).sort()).toEqual(["fresh1", "fresh2"]);
    } finally {
      resetDbSingletonForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
