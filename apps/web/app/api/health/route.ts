import { NextResponse } from "next/server";
import { getDb } from "../../../db/client";
import { getStats } from "../../../lib/stats";

/**
 * web 側の観測面（バックエンド堅牢化サイクル2「修正B」）。
 *
 * `packages/relay` の `GET /health` と対称に、ingest の `stats.snapshot()`
 * （accepted / dropped 理由別カウンタ。`lib/stats.ts`）と DB 接続状態
 * （`getDb() !== null` で判定）を返す。カウンタを読む面が無ければ修正A（#3）の
 * 観測投資が無駄になるため新設した（理解フェーズ missed_gap:
 * `no-web-observability-surface`）。
 *
 * 件数・状態のみを返し機微情報は一切含めない（NFR-4）。
 */

// ビルド時の静的解析で本ルートが評価されると getDb() が走り、副作用として
// 本番の DB ファイルが作られてしまう（ingest/stream と同じ理由で明示的に動的とする）。
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const snapshot = getStats().snapshot();
  return NextResponse.json({
    ...snapshot,
    db: getDb() !== null ? "up" : "down",
  });
}
