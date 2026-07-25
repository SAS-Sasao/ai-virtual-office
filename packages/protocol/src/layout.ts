// 本ファイルが OfficeLayout / Character の唯一の正本（M1-3）。他パッケージは
// z.infer で型導出のみ行い、再定義しないこと（TypeScript ルール 1）。
//
// 座標系: Room / Furniture の x/y/w/h は Floor.grid のタイル単位（アーキ設計 §5.1 /
// ADR-002）。backdrop（一枚絵背景）はレイヤー 0 の任意装飾であり、backdrop の有無に
// かかわらずレイヤー 1〜2（部屋・家具）のデータは常に存在する不変条件を守ること。
//
// CharacterSchema は role↔キャラの静的な正本であり、実行時セッション状態（どのキャラが
// 今どのツールを使っているか等）は持たせない。それは apps/web/game 側の SessionCharacter
// の責務であり、混入させると静的定義と動的状態の境界が崩れる（rev.2 で session フィールドを
// 削除した経緯）。
import { z } from "zod";

export const CharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  dept: z.string().min(1),
  org: z.string().min(1),
  model: z.string().optional(),
});

export type Character = z.infer<typeof CharacterSchema>;

export const RoomSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["active", "standby"]),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  triggers: z.array(z.string()),
  /**
   * 部屋の境界タイル（壁）のうち、隣接する廊下タイルに面する通行可能な 1 タイル
   * （M1-4a・破壊的変更で必須化）。
   *
   * **契約**: door は部屋の境界上の座標（Floor.grid のタイル単位）であり、door の
   * 直下または直隣には必ず廊下タイル（どの部屋にも属さないタイル）が存在する。
   * **連結性（フロア入口 → 各 active 部屋の door 経由で内部）は cc-sier-adapter が
   * レイアウト生成時に不変条件として保証する**（BFS 検証・違反時は該当組織の生成を
   * エラーにし、既存出力を上書きしない。cc-sier-adapter/import-org.ts の
   * `checkFloorConnectivity` を参照）。apps/web/game 側は door 位置を推測せず、この
   * フィールドをそのまま歩行可否グリッドの穴として扱ってよい。
   *
   * 手書き JSON（CC-SIer 以外の組織定義）を書く場合も、上記の連結性契約を満たす
   * door 座標を自分で用意する責務を負う（アプリ本体はこれを検証しない）。
   */
  door: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  /**
   * true の場合、cc-sier-adapter の再インポートで生成分による上書きから保護される
   * （FR-3 の冪等性・手動編集領域の保護。マージ規則は cc-sier-adapter/import-org.ts）。
   */
  custom: z.boolean().optional(),
});

export type Room = z.infer<typeof RoomSchema>;

export const FurnitureSchema = z.object({
  kind: z.string().min(1),
  x: z.number().int(),
  y: z.number().int(),
  /** RoomSchema.custom と同義。再インポートでの上書き保護フラグ。 */
  custom: z.boolean().optional(),
});

export type Furniture = z.infer<typeof FurnitureSchema>;

export const FloorSchema = z.object({
  org: z.string().min(1),
  label: z.string().min(1),
  /** フロア一枚絵背景（任意）。座標系は grid のタイルグリッドに一致させる（cover 拡縮しない）。 */
  backdrop: z.string().optional(),
  grid: z.object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    tileSize: z.number().int().positive(),
  }),
  rooms: z.array(RoomSchema),
  furniture: z.array(FurnitureSchema),
});

export type Floor = z.infer<typeof FloorSchema>;

export const OfficeLayoutSchema = z.object({
  version: z.literal(1),
  floors: z.array(FloorSchema),
});

export type OfficeLayout = z.infer<typeof OfficeLayoutSchema>;
