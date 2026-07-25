import type { FloorTabItem } from "./components/FloorTabs";
import { EMPTY_LAYOUT_META, OfficeView, type LayoutMeta } from "./OfficeView";
import { loadOfficeLayoutData, resolveLayoutsDir } from "../lib/layout";
import { resolveReceptionistName } from "./lib/narration";

// このルートは常に動的（force-dynamic）とする。office-layout.json /
// characters.json は cc-sier-adapter の再インポートで書き換わりうるため、
// ビルド時の静的プリレンダリングにキャッシュさせない（app/api/layout/route.ts
// と同じ理由）。
export const dynamic = "force-dynamic";

/**
 * サーバコンポーネント（デフォルトエクスポート）。`GET /api/layout` と同じ
 * `loadOfficeLayoutData` をサーバ側で直接呼び、フロアタブ・受付名を**初回 HTML**
 * から表示できるようにする（curl 等の非 JS クライアントでも確認できる。M1-4b
 * AC-11「HTML にフロアタブ 3 件」）。ゲーム本体（Scene / renderer / SSE 購読）は
 * 引き続きクライアント側の `OfficeView`（"use client"）が自前で `/api/layout` を
 * fetch して構築する（既存の client-fetch パターンは変えない。このサーバ側の
 * 読み込みはヘッダ表示専用の SSR シード）。
 */
export default async function OfficePage() {
  const initialLayoutMeta = loadInitialLayoutMeta();
  return <OfficeView initialLayoutMeta={initialLayoutMeta} />;
}

function loadInitialLayoutMeta(): LayoutMeta {
  try {
    const dir = resolveLayoutsDir();
    const { layout, characters } = loadOfficeLayoutData(dir);
    if (!layout) return EMPTY_LAYOUT_META;

    const floors: FloorTabItem[] = layout.floors.map((f) => ({ org: f.org, label: f.label }));
    return { floors, receptionistName: resolveReceptionistName(characters) };
  } catch {
    // レイアウト未インポート環境・読み取り失敗のいずれでも例外を投げず、
    // クライアント側の fetch に解決を委ねる（NFR-2 と同じ「壊れたデータで
    // 落ちない」思想。SSR はあくまで表示の最適化であり必須経路ではない）。
    return EMPTY_LAYOUT_META;
  }
}
