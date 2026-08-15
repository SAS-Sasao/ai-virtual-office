import { describe, expect, it, vi } from "vitest";
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

/**
 * サイクル2b（DB durability）design memo 注記のとおり、`Db`（drizzle の
 * `BetterSQLite3Database<typeof schema>`）は型上 `$client` を公開していない
 * （交差型が剥がれるため素では TS2339）。しかし実行時には drizzle が
 * `db.$client` に raw better-sqlite3 ハンドルを代入しているので、PRAGMA の
 * 読み戻し検証はテスト側でキャストして行う。プロダクション型（`Db`）は
 * 変えない（`$client` を広く露出させない）。
 */
function rawHandle(db: import("./client").Db): import("better-sqlite3").Database {
  return (db as unknown as { $client: import("better-sqlite3").Database }).$client;
}

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

  // AC-1: journal_mode=WAL はファイル DB に対して設定される（ファイル永続属性
  // なので当該接続でも開き直しでも観測できるが、ここでは当該接続の $client
  // から読む）。`:memory:` は no-op のため対象外（別テストで回帰を担保）。
  it("sets journal_mode=WAL for a file-backed db (AC-1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-wal-test-"));
    const dbPath = join(dir, "events.db");
    try {
      const db = createDb(dbPath);
      expect(db).not.toBeNull();
      const mode = rawHandle(db!).pragma("journal_mode", { simple: true });
      expect(mode).toBe("wal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC-2: synchronous=NORMAL / busy_timeout=5000 は per-connection の設定
  // なので、必ず createDb が開いた当該接続の $client から読む（開き直すと
  // 既定値になってしまい検証にならない）。
  it("sets synchronous=NORMAL and busy_timeout=5000 on the connection it opens (AC-2, file-backed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-pragma-test-"));
    const dbPath = join(dir, "events.db");
    try {
      const db = createDb(dbPath);
      expect(db).not.toBeNull();
      const handle = rawHandle(db!);
      expect(handle.pragma("busy_timeout", { simple: true })).toBe(5000);
      // synchronous: NORMAL == 1 (OFF=0, NORMAL=1, FULL=2, EXTRA=3)
      expect(handle.pragma("synchronous", { simple: true })).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets synchronous=NORMAL and busy_timeout=5000 on the connection it opens (AC-2, :memory:)", () => {
    const db = createDb(":memory:");
    expect(db).not.toBeNull();
    const handle = rawHandle(db!);
    expect(handle.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(handle.pragma("synchronous", { simple: true })).toBe(1);
  });

  // AC-3: PRAGMA 発行を追加しても、既存の「初期化不能で null・throw しない」
  // 契約は壊れない（PRAGMA は既存の try/catch の中で発行されるため）。
  it("still returns a usable Db (not null, not throwing) for :memory: and a file path after adding PRAGMAs (AC-3)", () => {
    expect(() => createDb(":memory:")).not.toThrow();
    expect(createDb(":memory:")).not.toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-ac3-test-"));
    const dbPath = join(dir, "events.db");
    try {
      expect(() => createDb(dbPath)).not.toThrow();
      expect(createDb(dbPath)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * M1-2a からの繰り越し（#3）: `getDb()` 初回接続時に一度だけ走る 30 日 prune
 * （要件 §7）の統合テスト。`createDb()` の戻り値の**型**（`Db` =
 * `BetterSQLite3Database<typeof schema>`）は生の better-sqlite3 ハンドルを
 * 公開していないため、「別プロセスが書き込んだファイルを開く」形の検証は
 * 型上できない（サイクル2b で `rawHandle()` ヘルパーが使っている
 * `db.$client` は drizzle が実行時に代入する非公開 seam であり、PRAGMA の
 * 読み戻し専用にキャストして使うもの。プロダクション型を広げる話ではない）。
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

/**
 * サイクル2b（DB durability）design memo §B: `getDb(path, now)` の注入 `now`
 * によるスロットル付き定期 prune。実 sleep・実タイマーは使わず、`now` を
 * 跨いで `getDb` を呼び分けることで決定論的に検証する。シングルトンは
 * リセットせず、同一プロセス内接続に対する 2 回目以降の `getDb` 呼び出しが
 * 対象（`resetDbSingletonForTests()` を挟む「初回接続の再現」である prune-on-init
 * の既存テストとは別の経路）。
 */
describe("getDb() の定期 prune（間隔経過後の再実行・スロットル・WAL checkpoint）", () => {
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
  const NOW0 = 1_700_000_000_000;

  it("prune 間隔（既定1時間）経過後の getDb 呼び出しで古い行が再 prune される (AC-4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-periodic-prune-test-"));
    const dbPath = join(dir, "events.db");
    resetDbSingletonForTests();

    try {
      const db = getDb(dbPath, NOW0);
      expect(db).not.toBeNull();

      // 初回接続完了後に古い行・新しい行を insert する（prune-on-init は
      // 空の新規ファイルに対して既に完了済みなので、この insert は影響を
      // 受けない）。
      insertEvent(db!, { type: "session_start", sessionId: "old", ts: NOW0 - THIRTY_ONE_DAYS_MS });
      insertEvent(db!, { type: "session_start", sessionId: "fresh", ts: NOW0 });

      // シングルトンをリセットせず、間隔経過後の now で getDb を呼ぶ。
      const db2 = getDb(dbPath, NOW0 + ONE_HOUR_MS);
      expect(db2).not.toBeNull();

      const rows = db2!.select().from(events).all();
      expect(rows.map((r) => r.sessionId).sort()).toEqual(["fresh"]);
    } finally {
      resetDbSingletonForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prune 間隔未満の getDb 呼び出しでは再 prune しない（スロットル） (AC-5)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-periodic-prune-throttle-test-"));
    const dbPath = join(dir, "events.db");
    resetDbSingletonForTests();

    try {
      const db = getDb(dbPath, NOW0);
      expect(db).not.toBeNull();

      insertEvent(db!, { type: "session_start", sessionId: "old", ts: NOW0 - THIRTY_ONE_DAYS_MS });
      insertEvent(db!, { type: "session_start", sessionId: "fresh", ts: NOW0 });

      // 間隔（1時間）の半分しか経過していないので再 prune は走らない。
      const db2 = getDb(dbPath, NOW0 + ONE_HOUR_MS / 2);
      expect(db2).not.toBeNull();

      const rows = db2!.select().from(events).all();
      expect(rows.map((r) => r.sessionId).sort()).toEqual(["fresh", "old"]);
    } finally {
      resetDbSingletonForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("定期 prune 実行時に wal_checkpoint(TRUNCATE) を best-effort 実行する (AC-6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-periodic-checkpoint-test-"));
    const dbPath = join(dir, "events.db");
    resetDbSingletonForTests();

    try {
      const db = getDb(dbPath, NOW0);
      expect(db).not.toBeNull();

      const handle = rawHandle(db!);
      const pragmaSpy = vi.spyOn(handle, "pragma");

      const db2 = getDb(dbPath, NOW0 + ONE_HOUR_MS);
      expect(db2).not.toBeNull();

      expect(pragmaSpy).toHaveBeenCalledWith(expect.stringContaining("wal_checkpoint"));

      pragmaSpy.mockRestore();
    } finally {
      resetDbSingletonForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkpoint が throw しても getDb は接続を無効化せず Db を返し続ける (AC-6, failure path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-periodic-checkpoint-fail-test-"));
    const dbPath = join(dir, "events.db");
    resetDbSingletonForTests();

    try {
      const db = getDb(dbPath, NOW0);
      expect(db).not.toBeNull();

      const handle = rawHandle(db!);
      const originalPragma = handle.pragma.bind(handle);
      vi.spyOn(handle, "pragma").mockImplementation((source, options) => {
        if (typeof source === "string" && source.includes("wal_checkpoint")) {
          throw new Error("simulated checkpoint failure");
        }
        return originalPragma(source, options);
      });

      let db2: ReturnType<typeof getDb> = null;
      expect(() => {
        db2 = getDb(dbPath, NOW0 + ONE_HOUR_MS);
      }).not.toThrow();
      expect(db2).not.toBeNull();
      expect(db2).toBe(db); // 既存のキャッシュ済み接続を無効化しない

      vi.restoreAllMocks();
    } finally {
      resetDbSingletonForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
