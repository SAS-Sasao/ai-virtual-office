import { gte, lt } from "drizzle-orm";
import { OfficeEventSchema, type OfficeEvent } from "@ai-office/protocol";
import { PRUNE_TIMEOUT_MS } from "../game/office-state";
import type { Db } from "./client";
import { events, type EventRow } from "./schema";

/**
 * DB 行を OfficeEvent へ変換する。`OfficeEventSchema.safeParse` を必ず通し、
 * 万一 DB の内容が壊れていても（今サイクルは drizzle-kit migration が無く
 * raw SQL 管理のため将来のスキーマ変更で不整合が起き得る）例外を投げず
 * 黙ってスキップできるようにする（NFR-2 と同じ「壊れたデータで落ちない」思想）。
 */
/**
 * seq/ts による順序比較用のキー。
 *
 * `apps/web/game/office-state.ts` の `compareOrder`（非公開のため import
 * できない）と**同一の規則**を再実装したもの。protocol の順序規約
 * （packages/protocol の OfficeEventSchema doc comment）どおり、両者が
 * seq を持つ場合のみ seq で比較し、どちらかが欠けている場合は ts で比較する。
 * この規則が office-state.ts のものとずれていないことは、下の
 * events.test.ts の compareOrder 系テスト（seq 逆順 / 片方 seq 欠落 / 両方
 * seq 欠落）で固定している。
 */
interface OrderKey {
  seq?: number;
  ts: number;
}

function toOrderKey(row: Pick<EventRow, "seq" | "ts">): OrderKey {
  return { seq: row.seq ?? undefined, ts: row.ts };
}

/** a が b より新しければ正、古ければ負、同時点なら 0。 */
function compareOrder(a: OrderKey, b: OrderKey): number {
  if (a.seq !== undefined && b.seq !== undefined) {
    return a.seq - b.seq;
  }
  return a.ts - b.ts;
}

function rowToOfficeEvent(row: EventRow): OfficeEvent | null {
  const candidate = {
    type: row.type,
    sessionId: row.sessionId,
    ts: row.ts,
    ...(row.toolName !== null ? { toolName: row.toolName } : {}),
    ...(row.fileBase !== null ? { fileBase: row.fileBase } : {}),
    ...(row.subagentType !== null ? { subagentType: row.subagentType } : {}),
    ...(row.seq !== null ? { seq: row.seq } : {}),
  };

  const result = OfficeEventSchema.safeParse(candidate);
  if (!result.success) {
    console.warn(`web: skipping malformed events row id=${row.id}`, result.error.message);
    return null;
  }
  return result.data;
}

/**
 * OfficeEvent を 1 件保存する。
 *
 * NFR-4: OfficeEvent 自体が既に Relay 側で機微情報フィルタ済みであり、かつ
 * events テーブルには OfficeEvent のフィールド以外の列が存在しないため、
 * 機微情報が保存される経路はそもそも存在しない（列が無ければ入りようがない）。
 */
export function insertEvent(db: Db, ev: OfficeEvent): void {
  db.insert(events)
    .values({
      type: ev.type,
      sessionId: ev.sessionId,
      toolName: ev.toolName ?? null,
      fileBase: ev.fileBase ?? null,
      subagentType: ev.subagentType ?? null,
      ts: ev.ts,
      seq: ev.seq ?? null,
      receivedAt: Date.now(),
    })
    .run();
}

/**
 * セッションごとの最新 1 件のみを返す（NFR-3: 最新状態優先。全イベントの
 * 再生ではない）。`now - windowMs` より古い（最新イベントの `ts` がそれ以前の）
 * セッションは対象外にする。
 *
 * `windowMs` の既定は `apps/web/game/office-state.ts` の `PRUNE_TIMEOUT_MS`
 * と同値（定数を重複定義せずそのまま import する）。
 *
 * 「最新」の判定は挿入順（id）ではなく `compareOrder`（protocol の順序規約）
 * で行う。N-2（head-of-line 撤回）により、seq が若いイベントが後から
 * ingest に届く（= 後から insert される）のは正常な入力形状であるため、
 * insert 順に依存すると同一 ts で seq が逆順に届いた際に古い方を「最新」と
 * 誤判定する（Phase 3 レビュー medium finding）。
 *
 * 戻り値は `ts` 昇順（決定論的なテスト・SSE 送出順のため）。同一セッション内の
 * 順序は問題にならない（各セッションにつき 1 件しか含まれないため）。
 */
export function loadRecentSessions(
  db: Db,
  now: number,
  windowMs: number = PRUNE_TIMEOUT_MS,
): OfficeEvent[] {
  const cutoff = now - windowMs;

  // SQL 側の orderBy は決定論的なテスト・走査のための補助的な並びに過ぎず、
  // 「どちらが最新か」の最終判定は必ず compareOrder で行う（ts, id 順に
  // 依存しない）。
  const rows = db.select().from(events).where(gte(events.ts, cutoff)).orderBy(events.ts, events.id).all();

  const latestBySession = new Map<string, EventRow>();
  for (const row of rows) {
    const existing = latestBySession.get(row.sessionId);
    if (!existing || compareOrder(toOrderKey(row), toOrderKey(existing)) >= 0) {
      latestBySession.set(row.sessionId, row);
    }
  }

  const result: OfficeEvent[] = [];
  for (const row of latestBySession.values()) {
    const ev = rowToOfficeEvent(row);
    if (ev) {
      result.push(ev);
    }
  }

  return result.sort((a, b) => a.ts - b.ts);
}

/**
 * `cutoffTs` より古い（`ts < cutoffTs`）行を削除する（要件 §7: 30 日ローテーション）。
 * 削除した件数を返す。
 */
export function pruneOlderThan(db: Db, cutoffTs: number): number {
  const result = db.delete(events).where(lt(events.ts, cutoffTs)).run();
  return result.changes;
}
