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
    sqlite.exec(CREATE_TABLE_SQL);
    return drizzle(sqlite, { schema });
  } catch (err) {
    console.warn(`web: failed to open/initialize sqlite db at ${path} (persistence disabled)`, err);
    return null;
  }
}

const GLOBAL_KEY = "__aiOfficeDb__";

type GlobalWithDb = typeof globalThis & {
  [GLOBAL_KEY]?: Db | null;
};

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
 * 引数なしで `resolveDbPath()` の既定解決に任せる。
 *
 * 接続確立に成功した最初の呼び出しでは、30 日ローテーション（要件 §7）の
 * `pruneOlderThan` を一度だけ実行する（以後はキャッシュを返すだけなので
 * 毎リクエストでは走らない）。prune 自体が失敗しても接続は無効にしない
 * （NFR-2 と同じ「壊れても止めない」思想）。
 */
export function getDb(path: string = resolveDbPath()): Db | null {
  const g = globalThis as GlobalWithDb;
  if (!(GLOBAL_KEY in g)) {
    const db = createDb(path);
    if (db) {
      try {
        const deleted = pruneOlderThan(db, Date.now() - THIRTY_DAYS_MS);
        if (deleted > 0) {
          console.log(`web: pruned ${deleted} event(s) older than 30 days on db init`);
        }
      } catch (err) {
        console.warn("web: failed to run the initial 30-day prune (ignored)", err);
      }
    }
    g[GLOBAL_KEY] = db;
  }
  return g[GLOBAL_KEY] ?? null;
}

/** テスト専用: globalThis に保持されたシングルトンをリセットする。 */
export function resetDbSingletonForTests(): void {
  const g = globalThis as GlobalWithDb;
  delete g[GLOBAL_KEY];
}
