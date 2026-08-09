import { NextResponse } from "next/server";
import { OfficeEventSchema } from "@ai-office/protocol";
import { publish } from "../../../lib/bus";
import { getDb } from "../../../db/client";
import { insertEvent } from "../../../db/events";
import { getStats } from "../../../lib/stats";

/**
 * hooks の唯一の宛先は Relay（packages/relay、既定 :4100）である。本エンドポイントは
 * Relay が正規化・機微情報フィルタ（NFR-4）を済ませた OfficeEvent のみを受け取る
 * （M1-1 以降、生の Claude Code hooks JSON は直接受理しない）。
 *
 * hooks 側は `curl -s ... --max-time 2 || true` で失敗を握り潰す前提だが、
 * 受け側もそれに甘えず、いかなる入力（JSON parse 不能・スキーマ不一致・
 * 予期せぬ形状）でも例外を投げず常に 200 を返す。Relay や Claude Code の
 * セッション進行を ingest 側の不具合で妨げてはならない（NFR-2）。
 */

// ビルド時の静的解析でこのルートが評価されると getDb() が走り、
// 副作用として本番の DB ファイル（既定 ~/.ai-office/events.db）が作られてしまう。
// このルートは本質的に動的（副作用を伴う POST）なので明示的に除外する。
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const raw: unknown = await req.json();
    const result = OfficeEventSchema.safeParse(raw);

    if (!result.success) {
      // バックエンド堅牢化サイクル2「修正A」(AC-1): schema 不一致の無言ドロップを
      // 観測可能化する。フィールド値（件数/理由以外）はログに一切出さない
      // （NFR-4 多層防御。生 hooks JSON にはセッションID等が含まれ得るため）。
      console.warn("web: ingest dropped invalid event (schema)");
      getStats().recordDropped("schema");
      return NextResponse.json({ ok: true, ignored: true });
    }

    // ライブ配信（SSE）を先に必ず実行する。永続化（SQLite）は付加価値であり、
    // DB が使えない・書き込みに失敗しても ingest のライブ配信・200 応答を
    // 妨げてはならない（M1-2a 設計メモ「apps/web の結線」参照）。
    publish(result.data);
    getStats().recordAccepted();

    try {
      const db = getDb();
      if (db) {
        insertEvent(db, result.data);
      }
    } catch (err) {
      console.warn("web: failed to persist event to sqlite (ignored, live delivery unaffected)", err);
    }

    return NextResponse.json({ ok: true, ignored: false });
  } catch (err) {
    // バックエンド堅牢化サイクル2「修正A」(AC-2): JSON parse 不能な入力の無言
    // ドロップを観測可能化する。⚠NFR-4 多層防御: `JSON.parse` の SyntaxError は
    // 不正な body の断片をメッセージに埋め込むため、生の err オブジェクト・
    // err.message・body は一切ログに出さず、安定プレフィックス + err.name のみに
    // 限定する（relay を迂回した生 hooks JSON が来た場合の将来のクラウドログ
    // 流出を防ぐ）。
    const name = err instanceof Error ? err.name : "unknown";
    console.warn(`web: ingest dropped unparseable body (${name})`);
    getStats().recordDropped("unparseable");
    return NextResponse.json({ ok: true, ignored: true });
  }
}
