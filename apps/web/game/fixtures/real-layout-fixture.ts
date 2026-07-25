// 実レイアウト形状の fixture（M1-4a AC-4 用）。
//
// cc-sier-adapter の `buildOrgFloor`（packages/cc-sier-adapter/src/import-org.ts）
// に domain-tech-collection の実マスタ（同パッケージの
// `src/fixtures/masters.ts` の ORGANIZATION_MD / DEPARTMENTS_MD / ROLES_MD、
// 2026-07-25 実測のコピー）をそのまま通して得た**実出力を凍結**したもの
// （2 部署の実務室 + 受付、3 ロール）。door・furniture の座標は adapter が
// 実際に計算した値であり、本ファイルでは再生成しない（apps/web/game は
// cc-sier-adapter に依存しない方針のため、生成コードではなく出力データの
// スナップショットとして保持する）。
//
// 実 3 フロア全体での接続性は adapter 側の生成時不変条件（checkFloorConnectivity）
// と、本サイクルでは layout-runtime.real-repo.integration.test.ts（AC-3b②）が
// 実 adapter CLI の出力に対して直接検証する。このフィクスチャは「adapter が
// 生成するレイアウトの形」を固定した軽量版であり、CI 移植性のために実リポジトリ
// 非依存で使う（real-repo.integration.test.ts と同じ設計判断）。
import type { Character, Floor } from "@ai-office/protocol";

export const REAL_SHAPE_FLOOR: Floor = {
  org: "domain-tech-collection",
  label: "ドメイン知識や技術スタック収集PJT",
  grid: { cols: 30, rows: 14, tileSize: 32 },
  rooms: [
    {
      id: "dept-research",
      name: "技術リサーチ室",
      status: "active",
      x: 1,
      y: 1,
      w: 5,
      h: 6,
      triggers: ["調査", "リサーチ", "PoC", "検証", "トレンド", "比較", "技術スタック"],
      door: { x: 3, y: 6 },
    },
    {
      id: "dept-retail-domain",
      name: "小売ドメイン室",
      status: "active",
      x: 7,
      y: 1,
      w: 5,
      h: 6,
      triggers: ["小売", "リテール", "流通", "店舗", "POS", "MD", "棚割", "商品マスタ", "発注", "在庫", "EC", "オムニチャネル"],
      door: { x: 9, y: 6 },
    },
    {
      id: "dept-secretary",
      name: "秘書室",
      status: "active",
      x: 12,
      y: 8,
      w: 5,
      h: 5,
      triggers: ["TODO", "タスク", "壁打ち", "相談", "メモ", "ダッシュボード"],
      door: { x: 14, y: 12 },
    },
  ],
  furniture: [
    { kind: "desk", x: 13, y: 10 },
    { kind: "desk", x: 2, y: 4 },
    { kind: "desk", x: 8, y: 4 },
  ],
};

export const REAL_SHAPE_CHARACTERS: Character[] = [
  {
    id: "domain-tech-collection:secretary",
    name: "秘書",
    role: "secretary",
    dept: "dept-secretary",
    org: "domain-tech-collection",
    model: "opus",
  },
  {
    id: "domain-tech-collection:tech-researcher",
    name: "テクニカルリサーチャー",
    role: "tech-researcher",
    dept: "dept-research",
    org: "domain-tech-collection",
    model: "sonnet",
  },
  {
    id: "domain-tech-collection:retail-domain-researcher",
    name: "小売ドメインリサーチャー",
    role: "retail-domain-researcher",
    dept: "dept-retail-domain",
    org: "domain-tech-collection",
    model: "sonnet",
  },
];
