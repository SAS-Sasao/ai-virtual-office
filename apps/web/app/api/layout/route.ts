import { NextResponse } from "next/server";
import { loadOfficeLayoutData, resolveLayoutsDir } from "../../../lib/layout";

/**
 * `office-layout.json` / `characters.json`（cc-sier-adapter が
 * `AI_OFFICE_LAYOUTS_DIR`（既定 `~/.ai-office/layouts/`）に生成する）を読み、
 * protocol スキーマ（`OfficeLayoutSchema` / `CharacterSchema`）で parse して
 * から `{ layout, characters }` を返す。
 *
 * ファイル不在・不正 JSON・スキーマ不一致（`RoomSchema.door` 必須化前の旧形式を
 * 含む）のいずれでも例外を投げず、常に 200 + `{ layout: null, characters: [] }`
 * を返す（`lib/layout.ts` の `loadOfficeLayoutData` が担保。M1-2a の
 * ingest/stream と同じ「壊れたデータで落ちない」思想）。game 側はこのフォール
 * バック形状を受けて単一フロア・単一部屋のデフォルトレイアウトを描く
 * （レイアウト未インポートでも壊れない）。
 */

// ビルド時の静的解析で本ルートが評価されるとファイル読み取りが走ってしまう
// （ingest/stream と同じ理由で明示的に動的とする。M1-2a の教訓）。
// 読み取りはリクエスト毎（キャッシュ・watch は M2 スコープ）。
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const dir = resolveLayoutsDir();
  const data = loadOfficeLayoutData(dir);
  return NextResponse.json(data);
}
