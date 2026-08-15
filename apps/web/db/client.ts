import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as schema from "./schema";
import { pruneOlderThan } from "./events";

/**
 * 30 日ローテーション（要件 §7）。DB 初期化時（プロセス内で最初に接続を
 * 確立したタイミング）に一度だけ実行する。events.ts の `pruneOlderThan` を
 * import しているが、events.ts 側の `Db` 型 import は type-only
 * （`import type`）のため実行時の循環 import には ならない。
 */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 定期 prune のスロットル間隔（サイクル2b: DB durability 設計メモ §B）。
 * `getDb` は呼ばれるたびにこの間隔が経過しているかを注入 `now` でチェックし、
 * 経過していれば 30 日 prune + WAL checkpoint を再実行する。setInterval は
 * 使わない（決定論・リーク回避）。
 */
const PRUNE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 時間

/**
 * `better-sqlite3` は **`12.9.0` に厳密ピン留めする（`^` を付けない）**。
 *
 * M1-2a 設計メモ rev.3（N-1 対応）で実測した prebuild アセットの有無:
 *
 * | version              | Node 20 (ABI 115) | Node 24 (ABI 137) |
 * |-----------------------|--------------------|--------------------|
 * | 12.11.1（最新）        | 404                | 200                |
 * | 12.0.0                 | 200                | 404                |
 * | **12.9.0（採用・本ファイル）** | **200**      | **200**            |
 *
 * `package.json` の `engines` フィールドはこの根拠にしてはならない
 * （prebuild が存在しなくても `pnpm install` 自体は通ってしまうため、
 * 実行時に node-gyp のフルビルドへフォールバックし CI で失敗し得る）。
 * バージョンを上げる場合は
 * `https://github.com/WiseLibs/better-sqlite3/releases/download/v<version>/better-sqlite3-v<version>-node-v<ABI>-linux-x64.tar.gz`
 * を対象 ABI ごとに curl で実測してから行うこと（AC-9）。
 */
const DEFAULT_DB_RELATIVE_PATH = join(".ai-office", "events.db");

/**
 * events テーブルの定義（db/schema.ts）と必ず一致させること。
 * drizzle-kit migration は M2 スコープのため、本サイクルは raw SQL で
 * `CREATE TABLE IF NOT EXISTS` を発行する。
 */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  toolName TEXT,
  fileBase TEXT,
  subagentType TEXT,
  ts INTEGER NOT NULL,
  seq INTEGER,
  receivedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_sessionId_idx ON events (sessionId);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
`;

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * DB ファイルパスを解決する。`AI_OFFICE_DB_PATH` > 既定 `~/.ai-office/events.db`。
 * `:memory:` もそのまま受け付ける（better-sqlite3 の特殊パス）。
 *
 * `env` は DI 可能（既定 `process.env`）。
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_OFFICE_DB_PATH ?? join(homedir(), DEFAULT_DB_RELATIVE_PATH);
}

/**
 * 指定パスに SQLite 接続を開き、テーブルを初期化して返す。
 *
 * **接続・初期化に失敗した場合は例外を投げず `null` を返す**。永続化は
 * 付加価値であり、DB が使えないことが理由でライブ表示（bus 経由の SSE 配信）
 * を止めてはならない。呼び出し側は必ず戻り値の null チェックを行い、
 * null の場合は永続化をスキップして処理を継続すること。
 */
export function createDb(path: string): Db | null {
  try {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const sqlite = new Database(path);
    // WAL + PRAGMA pin（サイクル2b: DB durability 設計メモ §A）。
    // `journal_mode=WAL` はクロスプロセスの reader/writer 相互ブロックを
    // 解消しクラッシュ耐性を上げる（`:memory:` では no-op、'memory' を返す）。
    // `synchronous=NORMAL` は WAL と組み合わせて推奨される設定。
    // `busy_timeout=5000` は better-sqlite3 のコンストラクタ既定と同値を
    // 明示 pin する（将来のライブラリ既定変更に対する回帰保険）。
    // いずれも同じ try 内で発行するため、失敗しても catch で null に落ちる
    // （＝既存の「失敗は null 返却・throw しない」契約は変わらない）。
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.exec(CREATE_TABLE_SQL);
    return drizzle(sqlite, { schema });
  } catch (err) {
    console.warn(`web: failed to open/initialize sqlite db at ${path} (persistence disabled)`, err);
    return null;
  }
}

const GLOBAL_KEY = "__aiOfficeDb__";

/**
 * シングルトンの格納形状。`GLOBAL_KEY in g` で「未接続 / 接続結果（成功 or
 * 失敗）」の 2 状態を判定する（既存の判定方式を維持）。`db: null` は
 * 接続確立に失敗した結果であり、この場合は `lastPruneAt` を持たない
 * （定期 prune のスロットル・checkpoint の対象外。サイクル2b 設計メモ §B の
 * null-cache 経路）。
 */
type DbSingletonWrapper = { db: Db; lastPruneAt: number } | { db: null };

type GlobalWithDb = typeof globalThis & {
  [GLOBAL_KEY]?: DbSingletonWrapper;
};

/** 30 日 prune を実行する（失敗しても投げない。既存ガードの共通化）。 */
function runPrune(db: Db, now: number, label: string): void {
  try {
    const deleted = pruneOlderThan(db, now - THIRTY_DAYS_MS);
    if (deleted > 0) {
      console.log(`web: pruned ${deleted} event(s) older than 30 days (${label})`);
    }
  } catch (err) {
    console.warn(`web: failed to run the 30-day prune (${label}, ignored)`, err);
  }
}

/**
 * WAL チェックポイントを best-effort で実行する（失敗しても接続を無効化しない）。
 * `journal_mode=WAL` 前提の運用で `-wal` サイドカーが単調増大しないよう、
 * 定期 prune のタイミングで明示的に切り詰める（サイクル2b 設計メモ §A checkpoint 方針）。
 */
function runWalCheckpoint(db: Db): void {
  try {
    const handle = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
    handle.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    console.warn("web: failed to run WAL checkpoint (ignored)", err);
  }
}

/**
 * プロセス内シングルトンとして DB 接続を取得する。
 *
 * dev のホットリロード（Next.js の Fast Refresh / モジュール再評価）を挟んでも
 * 接続が再生成・重複しないよう `globalThis` に保持する（`lib/bus.ts` と同じパターン）。
 * 初回呼び出し時に一度だけ `createDb()` を実行し、以後はキャッシュを返す
 * （失敗した結果＝`null` もキャッシュし、失敗するたびに再試行して起動を
 * 遅延させることはしない）。
 *
 * `path` 引数はテスト用の DI ポイントであり、通常の呼び出し（route handler）は
 * 引数なしで `resolveDbPath()` の既定解決に任せる。`now` も同様に DI 可能
 * （既定 `Date.now()`）で、定期 prune の決定論テストに使う。
 *
 * 接続確立に成功した最初の呼び出しでは、30 日ローテーション（要件 §7）の
 * `pruneOlderThan` を一度だけ実行する。以後は `getDb` が呼ばれるたびに
 * （setInterval は使わず）注入 `now` を見て、前回 prune から
 * `PRUNE_CHECK_INTERVAL_MS`（既定 1 時間）以上経過していれば prune + WAL
 * checkpoint を再実行する（サイクル2b 設計メモ §B）。prune / checkpoint が
 * 失敗しても接続は無効にしない（NFR-2 と同じ「壊れても止めない」思想）。
 * 初期化に失敗した場合（`db: null`）は、この throttle・prune・checkpoint の
 * 経路には一切入らない。
 */
export function getDb(path: string = resolveDbPath(), now: number = Date.now()): Db | null {
  const g = globalThis as GlobalWithDb;
  const existing = g[GLOBAL_KEY];

  if (!existing) {
    const db = createDb(path);
    if (db) {
      runPrune(db, now, "db init");
      g[GLOBAL_KEY] = { db, lastPruneAt: now };
    } else {
      g[GLOBAL_KEY] = { db: null };
    }
    return db;
  }

  if (existing.db && now - existing.lastPruneAt >= PRUNE_CHECK_INTERVAL_MS) {
    runPrune(existing.db, now, "periodic");
    runWalCheckpoint(existing.db);
    existing.lastPruneAt = now;
  }

  return existing.db;
}

/** テスト専用: globalThis に保持されたシングルトンをリセットする。 */
export function resetDbSingletonForTests(): void {
  const g = globalThis as GlobalWithDb;
  delete g[GLOBAL_KEY];
}
