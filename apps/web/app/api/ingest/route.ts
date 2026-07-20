import { NextResponse } from "next/server";
import { OfficeEventSchema } from "@ai-office/protocol";
import { publish } from "../../../lib/bus";

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
export async function POST(req: Request): Promise<Response> {
  try {
    const raw: unknown = await req.json();
    const result = OfficeEventSchema.safeParse(raw);

    if (!result.success) {
      return NextResponse.json({ ok: true, ignored: true });
    }

    publish(result.data);
    return NextResponse.json({ ok: true, ignored: false });
  } catch {
    return NextResponse.json({ ok: true, ignored: true });
  }
}
