// OfficeLayout（静的データ）→ 実行時構造（歩行可否グリッド・デスク割当・入口・
// 受付部屋）を導出する純関数群（M1-4a）。
//
// 歩行可否の契約: 部屋の境界タイルのうち `room.door`（protocol の RoomSchema.door、
// cc-sier-adapter が生成時に不変条件として連結性を保証した値）だけが歩行可能。
// game 側はドアの位置を推測しない（M1-4a rev.2 の F1 対応。詳細は
// packages/protocol/src/layout.ts の RoomSchema.door doc comment を参照）。
// なお本ファイルの `isWalkableTile` 相当のロジックは
// cc-sier-adapter/src/import-org.ts の `isWalkableTile` と同じ契約に従うが、
// apps/web/game は cc-sier-adapter に依存しない方針のため独立して実装している
// （契約はスキーマのドキュメントコメントを正本として両側で守る）。
import type { Character, Floor, OfficeLayout, Room } from "@ai-office/protocol";
import type { Tile, WalkGrid } from "./pathfinding";

/** CC-SIer マスタの受付部署 ID（cc-sier-adapter の RECEPTION_ID と同じ規約）。 */
export const RECEPTION_DEPT_ID = "dept-secretary";

/**
 * `floor.backdrop` 未設定フロアへ実行時に適用する既定の一枚絵背景（M2-2・ADR-006）。
 * 現状の生成レイアウト（`~/.ai-office/layouts`）は backdrop 未設定なため、これを
 * 既定として当てることで再インポートなしに全フロアで backdrop 機構を可視化できる。
 */
export const DEFAULT_BACKDROP = "/assets/backdrops/office.png";

/**
 * org ごとの部屋 backdrop テーマ（M2-2 拡張・ADR-006）。キャラの `ORG_THEME`
 * （renderer.ts）と揃える: RPG テーマの org はファンタジー部屋、他はオフィス部屋。
 * 未登録 org は `DEFAULT_BACKDROP`（オフィス）にフォールバックする。
 */
const BACKDROP_BY_ORG: Record<string, string> = {
  "jutaku-dev-team": "/assets/backdrops/fantasy.png",
};

/** org からその部屋 backdrop パスを返す（未登録は既定オフィス背景）。 */
export function backdropForOrg(org: string): string {
  return BACKDROP_BY_ORG[org] ?? DEFAULT_BACKDROP;
}

export interface RuntimeFloor {
  readonly floor: Floor;
  readonly walkGrid: WalkGrid;
  readonly entrance: Tile;
  /** characterId -> 自席タイル。デスクが割り当てられなかったキャラは含まれない。 */
  readonly deskByCharacterId: ReadonlyMap<string, Tile>;
  readonly receptionRoom: Room | undefined;
}

export interface RuntimeLayout {
  readonly floors: RuntimeFloor[];
}

/** タイル (x,y) を含む部屋を返す（矩形の半開区間 [x, x+w) x [y, y+h)）。 */
export function findRoomAt(floor: Floor, x: number, y: number): Room | undefined {
  return floor.rooms.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

/** フロア最下段中央のタイル。全フロア共通の入口規約（M1-4a 設計メモ item 1）。 */
export function resolveEntrance(floor: Floor): Tile {
  return { x: Math.floor(floor.grid.cols / 2), y: floor.grid.rows - 1 };
}

export function buildWalkGrid(floor: Floor): WalkGrid {
  const cols = floor.grid.cols;
  const rows = floor.grid.rows;
  return {
    cols,
    rows,
    isWalkable(x: number, y: number): boolean {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return false;
      const room = findRoomAt(floor, x, y);
      if (!room) return true; // 部屋に属さないタイルは廊下（歩行可）
      const isDoor = room.door.x === x && room.door.y === y;
      const isInterior = x > room.x && x < room.x + room.w - 1 && y > room.y && y < room.y + room.h - 1;
      return isDoor || isInterior;
    },
  };
}

export function findReceptionRoom(floor: Floor): Room | undefined {
  return floor.rooms.find((r) => r.id === RECEPTION_DEPT_ID);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 部屋の中央付近の内部タイル（訪問者の作業位置・visitor の目的地に使う）。
 * 内部タイルを持てない小さい部屋（w か h が 3 未満）では door タイルへ
 * フォールバックする（door は契約上必ず歩行可能）。
 */
export function roomInteriorAnchor(room: Room): Tile {
  if (room.w < 3 || room.h < 3) {
    return { x: room.door.x, y: room.door.y };
  }
  const cx = clamp(room.x + Math.floor(room.w / 2), room.x + 1, room.x + room.w - 2);
  const cy = clamp(room.y + Math.floor(room.h / 2), room.y + 1, room.y + room.h - 2);
  return { x: cx, y: cy };
}

/**
 * characters を dept（= room.id）ごとに決定的順序でデスクへ割り当てる。
 *
 * アルゴリズム: furniture の desk を、それを幾何的に含む部屋（room.id）でグループ化
 * し、characters も dept でグループ化する。両グループとも元の配列順序を保つため、
 * 同じ dept 内で「デスク配列の n 番目」と「キャラ配列の n 番目」を素直にペアにするだけで、
 * cc-sier-adapter の生成順（roles.md の出現順）と決定的に一致する（adapter の内部
 * アルゴリズムに依存しない、幾何的な包含関係だけを使う汎用ロジック）。
 * デスクが足りない場合は部屋の内部アンカー（roomInteriorAnchor）へフォールバックする。
 * dept に対応する部屋が存在しない場合はそのキャラをデスク未割当のまま返す
 * （呼び出し側が入口などへフォールバックする）。
 */
export function assignDesks(floor: Floor, characters: readonly Character[]): Map<string, Tile> {
  const desksByDept = new Map<string, Tile[]>();
  for (const furniture of floor.furniture) {
    if (furniture.kind !== "desk") continue;
    const room = findRoomAt(floor, furniture.x, furniture.y);
    if (!room) continue;
    const list = desksByDept.get(room.id) ?? [];
    list.push({ x: furniture.x, y: furniture.y });
    desksByDept.set(room.id, list);
  }

  const charactersByDept = new Map<string, Character[]>();
  for (const character of characters) {
    if (character.org !== floor.org) continue;
    const list = charactersByDept.get(character.dept) ?? [];
    list.push(character);
    charactersByDept.set(character.dept, list);
  }

  const result = new Map<string, Tile>();
  for (const [deptId, deptCharacters] of charactersByDept) {
    const room = floor.rooms.find((r) => r.id === deptId);
    const desks = desksByDept.get(deptId) ?? [];
    deptCharacters.forEach((character, index) => {
      const desk = desks[index];
      if (desk) {
        result.set(character.id, desk);
      } else if (room) {
        result.set(character.id, roomInteriorAnchor(room));
      }
    });
  }
  return result;
}

export function buildRuntimeFloor(floor: Floor, characters: readonly Character[]): RuntimeFloor {
  return {
    floor,
    walkGrid: buildWalkGrid(floor),
    entrance: resolveEntrance(floor),
    deskByCharacterId: assignDesks(floor, characters),
    receptionRoom: findReceptionRoom(floor),
  };
}

const FALLBACK_ORG = "default";
const FALLBACK_TILE_SIZE = 32;

/**
 * layout が null のとき（レイアウト未インポート環境）に使う単一部屋のフォールバック
 * レイアウト。M0 相当の「壊れない表示」を保つための最小構成（家具なし）。
 */
export function buildFallbackLayout(): OfficeLayout {
  const cols = 10;
  const rows = 8;
  const room: Room = {
    id: "office",
    name: "Office",
    status: "active",
    x: 1,
    y: 1,
    w: 8,
    h: 4,
    triggers: [],
    door: { x: 5, y: 4 },
  };

  return {
    version: 1,
    floors: [
      {
        org: FALLBACK_ORG,
        label: "Office",
        grid: { cols, rows, tileSize: FALLBACK_TILE_SIZE },
        rooms: [room],
        furniture: [],
      },
    ],
  };
}

/**
 * OfficeLayout（null ならフォールバック）+ characters から、フロアごとの実行時構造
 * （歩行可否グリッド・デスク割当・入口・受付部屋）をまとめて構築する。
 */
export function buildRuntimeLayout(layout: OfficeLayout | null, characters: readonly Character[]): RuntimeLayout {
  const effectiveLayout = layout ?? buildFallbackLayout();
  return {
    // backdrop 未設定フロアに既定 backdrop を **非破壊で** 適用する（M2-2・ADR-006・F1）。
    // 入力 floor を破壊変更せず spread のコピー側にだけ backdrop を載せる（純関数維持）。
    // 既に backdrop を持つフロアはその値を尊重する。
    floors: effectiveLayout.floors.map((floor) =>
      buildRuntimeFloor({ ...floor, backdrop: floor.backdrop ?? backdropForOrg(floor.org) }, characters),
    ),
  };
}
