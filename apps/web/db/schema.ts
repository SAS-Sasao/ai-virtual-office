import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `OfficeEvent`（packages/protocol）と 1:1 対応する永続化テーブル。
 *
 * 列名は OfficeEvent のフィールド名をそのまま使う（camelCase のまま。
 * snake_case への変換は行わない）。変換ロジックを一切持たないことで
 * db/events.ts の行 <-> OfficeEvent の相互変換を単純に保てる。
 *
 * drizzle-kit の migration は M2 スコープ。本サイクルでは
 * `db/client.ts` が `CREATE TABLE IF NOT EXISTS` を raw SQL で発行する
 * （この schema 定義とカラム定義を必ず一致させること）。
 */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    sessionId: text("sessionId").notNull(),
    toolName: text("toolName"),
    fileBase: text("fileBase"),
    subagentType: text("subagentType"),
    ts: integer("ts").notNull(),
    seq: integer("seq"),
    receivedAt: integer("receivedAt").notNull(),
  },
  (table) => [
    // loadRecentSessions（セッションごとの最新1件を探す）用のインデックス。
    index("events_sessionId_idx").on(table.sessionId),
    index("events_ts_idx").on(table.ts),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
