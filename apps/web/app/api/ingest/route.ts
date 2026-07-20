import { NextResponse } from "next/server";
import { publish } from "../../../lib/bus";
import { normalizeHookEvent } from "../../../lib/normalize";

/**
 * Claude Code hooks からのイベントを受信するエンドポイント。
 *
 * hooks 側は `curl -s ... --max-time 2 || true` で失敗を握り潰す前提だが、
 * 受け側もそれに甘えず、いかなる入力（JSON parse 不能・未対応イベント・
 * 予期せぬ形状）でも例外を投げず常に 200 を返す。Claude Code の
 * セッション進行を ingest 側の不具合で妨げてはならない（NFR-2）。
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const raw: unknown = await req.json();
    const event = normalizeHookEvent(raw, Date.now());

    if (!event) {
      return NextResponse.json({ ok: true, ignored: true });
    }

    publish(event);
    return NextResponse.json({ ok: true, ignored: false });
  } catch {
    return NextResponse.json({ ok: true, ignored: true });
  }
}
