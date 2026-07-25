// masters/*.md（の文字列内容）→ OfficeLayout + Character[] を生成する純関数。
// fs には一切触れない（走査は cli.ts の責務）。
//
// 決定論性: 出力に乱数・時刻を一切含めない。同じ入力（masters 文字列 + 既存出力）からは
// 常に同じバイト列が得られる（AC-3）。レイアウト自動生成のアルゴリズムはこのファイル内の
// 定数（GRID_COLS 等）に閉じ込め、値そのものは設計メモが明示していないため実装判断として
// ここで固定する（グリッド幅 30 タイル・行優先・部屋幅はロール数比例、という制約は遵守）。
//
// 連結性の保証（M1-4a rev.2・F1 の根本対応）: 部屋は「フロア外周 1 タイル + 行間 1 タイル」
// の廊下レーンの内側にのみ配置し、受付（dept-secretary）も他部屋と同じロール数比例幅に
// して最下段中央へ寄せる（全幅にしない）。各部屋の door（下辺のうち廊下に面するタイル・
// 中央優先）を計算し、生成直後に自己 BFS で「入口（フロア最下段中央）→ 全 active 部屋の
// door を経て内部」の到達可能性を検証する。違反時は該当組織の生成を ok:false として扱う
// （既存出力を上書きしない・warnings に理由を積む。RoomSchema.door の doc comment の契約と
// 対になる、adapter 側の実装義務）。
import {
  CharacterSchema,
  FloorSchema,
  type Character,
  type Floor,
  type Furniture,
  type OfficeLayout,
  type Room,
} from "@ai-office/protocol";
import { parseDepartments, parseOrganization, parseRoles } from "./parse-masters.js";
import { compareCodePoint } from "./sort-util.js";

/** フロアのグリッド幅（タイル）。要件どおり固定値。 */
export const GRID_COLS = 30;
/** フロア外周・部屋の行間に確保する廊下レーンの幅（タイル）。 */
const CORRIDOR_MARGIN = 1;
const ROOM_HEIGHT = 6;
/** 同一行内で隣り合う部屋どうしの間隔（廊下扱い）。 */
const ROOM_GAP = 1;
const ROOM_MIN_WIDTH = 5;
const WIDTH_PER_ROLE = 3;
const DESK_SPACING = 3;
const RECEPTION_ID = "dept-secretary";
const RECEPTION_HEIGHT = 5;
const DEFAULT_TILE_SIZE = 32;

export interface OrgMastersInput {
  orgId: string;
  organizationMd?: string;
  departmentsMd?: string;
  rolesMd?: string;
}

export type BuildOrgFloorOutcome =
  | { ok: true; floor: Floor; characters: Character[]; warnings: string[] }
  | { ok: false; warnings: string[] };

function roomWidthFor(roleCount: number): number {
  return Math.max(ROOM_MIN_WIDTH, WIDTH_PER_ROLE * roleCount + 2);
}

/** door を除いた部屋の幾何情報。door は全部屋の配置が確定した後の 2 パス目で計算する。 */
type RoomGeometry = Omit<Room, "door">;

/** (x, y) がどの部屋にも属さない（＝廊下タイルである）かどうかを判定する。 */
function isCorridorTile(x: number, y: number, rooms: readonly RoomGeometry[]): boolean {
  return !rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

/**
 * 部屋の下辺（境界タイル）のうち、直下が廊下タイルであるものを door として返す
 * （中央優先・「廊下レーンの確保」規則により通常は中央がそのまま採用される。中央が
 * 塞がっている場合のみ左右に探索を広げる防御的フォールバック）。
 */
function computeDoor(room: RoomGeometry, allRooms: readonly RoomGeometry[]): Room["door"] {
  const doorY = room.y + room.h - 1;
  const belowY = doorY + 1;
  const center = room.x + Math.floor((room.w - 1) / 2);

  for (let offset = 0; offset < room.w; offset += 1) {
    const candidateXs = offset === 0 ? [center] : [center - offset, center + offset];
    for (const x of candidateXs) {
      if (x < room.x || x >= room.x + room.w) continue;
      if (isCorridorTile(x, belowY, allRooms)) {
        return { x, y: doorY };
      }
    }
  }

  // フォールバック: 廊下レーンの確保規則（外周・行間 1 タイル）を守っている限り
  // 到達しない。万一到達しても door フィールドは必須のため中央を返し、後段の
  // checkFloorConnectivity がこの org の生成をエラーとして検出する。
  return { x: center, y: doorY };
}

export interface ConnectivityCheckResult {
  ok: boolean;
  /** 入口から door 経由で到達できなかった active 部屋の id（到達できていれば空配列）。 */
  unreachableRoomIds: string[];
}

const NEIGHBOR_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

function findRoomAt(floor: Floor, x: number, y: number): Room | undefined {
  return floor.rooms.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

function isWalkableTile(floor: Floor, x: number, y: number): boolean {
  if (x < 0 || x >= floor.grid.cols || y < 0 || y >= floor.grid.rows) return false;
  const room = findRoomAt(floor, x, y);
  if (!room) return true; // 部屋に属さないタイルは廊下（歩行可）
  const isDoor = room.door.x === x && room.door.y === y;
  const isInterior = x > room.x && x < room.x + room.w - 1 && y > room.y && y < room.y + room.h - 1;
  return isDoor || isInterior;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 部屋の中心寄りの内部代表タイル。`checkFloorConnectivity` が「door だけでなく
 * 内部そのものに到達できるか」まで検証するために使う（M1-4a Phase 3 レビュー指摘 2
 * への対応）。内部タイルを持てない小さい部屋（w か h が 3 未満）は door 自体へ
 * フォールバックする（契約上 door は必ず歩行可能なため、この場合は door 到達を以て
 * 内部到達とみなす）。
 *
 * apps/web/game/layout-runtime.ts の `roomInteriorAnchor` と同じ考え方（中心タイル・
 * 同じフォールバック規則）を、パッケージ間の非依存方針を保ったまま独立に実装している
 * （game は cc-sier-adapter に依存せず、逆方向の依存も作らない）。
 */
function interiorAnchor(room: Room): { x: number; y: number } {
  if (room.w < 3 || room.h < 3) {
    return { x: room.door.x, y: room.door.y };
  }
  const cx = clamp(room.x + Math.floor(room.w / 2), room.x + 1, room.x + room.w - 2);
  const cy = clamp(room.y + Math.floor(room.h / 2), room.y + 1, room.y + room.h - 2);
  return { x: cx, y: cy };
}

/**
 * 生成した Floor の連結性不変条件を検証する（M1-4a rev.2 F1 の根本対応）。
 *
 * 入口（フロア最下段中央のタイル）から 4 近傍 BFS を行い、各 active 部屋について
 * **door タイルと内部代表タイル（interiorAnchor）の両方**に到達できるかを確認する。
 * 通常、door は部屋の境界上にあり door から 1 タイル内側は常に部屋の内部
 * （interior）に接するため、door に到達できれば内部にも到達できる（interior は矩形で
 * 自明に全域連結）。**ただし door が部屋の「角」に来た場合は例外**で、角タイルは
 * 4 近傍のどの方向にも内部へ踏み込めず、door 自体は visited でも内部は完全に閉じた
 * ままになりうる（Phase 3 レビュー指摘 2・low）。door 到達だけでは見逃すこの穴を、
 * 内部代表タイルの到達も併せて要求することで塞ぐ。standby 部屋は要件どおり判定対象外
 * （閉鎖ドアの演出は描画側の責務であり、生成時の連結性契約には含めない）。
 */
export function checkFloorConnectivity(floor: Floor): ConnectivityCheckResult {
  const entrance = { x: Math.floor(floor.grid.cols / 2), y: floor.grid.rows - 1 };

  const visited = new Set<string>();
  const queue: Array<{ x: number; y: number }> = [];

  if (isWalkableTile(floor, entrance.x, entrance.y)) {
    visited.add(tileKey(entrance.x, entrance.y));
    queue.push(entrance);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    for (const [dx, dy] of NEIGHBOR_DELTAS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const key = tileKey(nx, ny);
      if (visited.has(key)) continue;
      if (!isWalkableTile(floor, nx, ny)) continue;
      visited.add(key);
      queue.push({ x: nx, y: ny });
    }
  }

  const unreachableRoomIds = floor.rooms
    .filter((r) => r.status === "active")
    .filter((r) => {
      const anchor = interiorAnchor(r);
      return !visited.has(tileKey(r.door.x, r.door.y)) || !visited.has(tileKey(anchor.x, anchor.y));
    })
    .map((r) => r.id);

  return { ok: unreachableRoomIds.length === 0, unreachableRoomIds };
}

/**
 * 1 組織分の masters 文字列から Floor + Character[] を生成する。
 *
 * - departments.md が無い、または有効な部署が 0 件の場合は ok:false を返す
 *   （import-org.ts レベルでは「その組織を除外」の判断のみ行い、CLI 全体としての
 *   graceful degradation 判定は cli.ts が全組織の結果を見て行う）
 * - 部署はマスタの出現順（行優先）で、フロア外周・行間に 1 タイルの廊下レーンを
 *   確保しながら配置する。部屋幅は所属ロール数に比例させる。dept-secretary は
 *   受付として最下段中央に、他部屋と同じ比例幅で配置する（全幅にはしない）
 * - standby 部署も部屋として配置する（描画側が消灯表現に使う。要件 §2.1）
 * - 各部屋の door（下辺のうち廊下に面するタイル）を計算し、生成直後に
 *   checkFloorConnectivity で「入口 → 全 active 部屋」の到達可能性を検証する。
 *   違反時は ok:false を返す（この org を除外し、既存出力を上書きしない）
 */
export function buildOrgFloor(input: OrgMastersInput): BuildOrgFloorOutcome {
  const warnings: string[] = [];
  const orgTag = `org "${input.orgId}"`;

  if (input.departmentsMd === undefined) {
    return { ok: false, warnings: [`${orgTag}: departments.md not found`] };
  }

  const deptResult = parseDepartments(input.departmentsMd);
  warnings.push(...deptResult.errors.map((e) => `${orgTag}: ${e}`));
  if (deptResult.departments.length === 0) {
    warnings.push(`${orgTag}: no valid departments after parsing (0 departments)`);
    return { ok: false, warnings };
  }

  const roleResult =
    input.rolesMd !== undefined ? parseRoles(input.rolesMd) : { roles: [], errors: [`${orgTag}: roles.md not found`] };
  warnings.push(...roleResult.errors.map((e) => (e.startsWith(orgTag) ? e : `${orgTag}: ${e}`)));

  const orgMeta = input.organizationMd !== undefined ? parseOrganization(input.organizationMd).organization : {};
  const label = orgMeta.name ?? input.orgId;

  const roleCountByDept = new Map<string, number>();
  for (const role of roleResult.roles) {
    roleCountByDept.set(role.dept, (roleCountByDept.get(role.dept) ?? 0) + 1);
  }

  const reception = deptResult.departments.find((d) => d.id === RECEPTION_ID);
  const others = deptResult.departments.filter((d) => d.id !== RECEPTION_ID);

  const roomsGeometry: RoomGeometry[] = [];
  let cursorX = CORRIDOR_MARGIN;
  let cursorY = CORRIDOR_MARGIN;
  let rowUsed = false;

  for (const dept of others) {
    const roleCount = roleCountByDept.get(dept.id) ?? 0;
    const width = roomWidthFor(roleCount);
    if (rowUsed && cursorX + width > GRID_COLS - CORRIDOR_MARGIN) {
      cursorX = CORRIDOR_MARGIN;
      cursorY += ROOM_HEIGHT + ROOM_GAP;
      rowUsed = false;
    }
    roomsGeometry.push({
      id: dept.id,
      name: dept.name,
      status: dept.status,
      x: cursorX,
      y: cursorY,
      w: width,
      h: ROOM_HEIGHT,
      triggers: dept.triggers,
    });
    cursorX += width + ROOM_GAP;
    rowUsed = true;
  }

  if (reception) {
    const receptionRoleCount = roleCountByDept.get(reception.id) ?? 0;
    const receptionWidth = roomWidthFor(receptionRoleCount);
    const receptionY = rowUsed ? cursorY + ROOM_HEIGHT + ROOM_GAP : cursorY;
    const availableWidth = GRID_COLS - 2 * CORRIDOR_MARGIN;
    const receptionX = CORRIDOR_MARGIN + Math.max(0, Math.floor((availableWidth - receptionWidth) / 2));
    roomsGeometry.push({
      id: reception.id,
      name: reception.name,
      status: reception.status,
      x: receptionX,
      y: receptionY,
      w: receptionWidth,
      h: RECEPTION_HEIGHT,
      triggers: reception.triggers,
    });
  } else {
    warnings.push(`${orgTag}: no "${RECEPTION_ID}" department found (reception room omitted)`);
  }

  const rooms: Room[] = roomsGeometry.map((geometry) => ({
    ...geometry,
    door: computeDoor(geometry, roomsGeometry),
  }));

  const roomsById = new Map(rooms.map((r) => [r.id, r]));
  const furniture: Furniture[] = [];
  const deskIndexByDept = new Map<string, number>();

  for (const role of roleResult.roles) {
    const room = roomsById.get(role.dept);
    if (!room) {
      warnings.push(`${orgTag}: role "${role.id}" references unknown department "${role.dept}" (desk omitted)`);
      continue;
    }
    const idx = deskIndexByDept.get(role.dept) ?? 0;
    deskIndexByDept.set(role.dept, idx + 1);
    const deskX = Math.min(room.x + 1 + idx * DESK_SPACING, room.x + room.w - 2);
    const deskY = room.y + Math.floor(room.h / 2);
    furniture.push({ kind: "desk", x: deskX, y: deskY });
  }

  const characters: Character[] = roleResult.roles.map((role) =>
    CharacterSchema.parse({
      id: `${input.orgId}:${role.id}`,
      name: role.name,
      role: role.id,
      dept: role.dept,
      org: input.orgId,
      ...(role.model !== undefined ? { model: role.model } : {}),
    }),
  );

  const maxBottom = rooms.reduce((max, r) => Math.max(max, r.y + r.h), 0);

  const floor = FloorSchema.parse({
    org: input.orgId,
    label,
    grid: { cols: GRID_COLS, rows: maxBottom + CORRIDOR_MARGIN, tileSize: DEFAULT_TILE_SIZE },
    rooms,
    furniture,
  });

  const connectivity = checkFloorConnectivity(floor);
  if (!connectivity.ok) {
    warnings.push(
      `${orgTag}: generated layout failed the connectivity invariant — room(s) [${connectivity.unreachableRoomIds.join(", ")}] are not reachable from the entrance via their door; aborting generation for this org (existing output left untouched)`,
    );
    return { ok: false, warnings };
  }

  return { ok: true, floor, characters, warnings };
}

export interface MergeFloorResult {
  floor: Floor;
  warnings: string[];
}

/**
 * 生成済み Floor に、既存出力の `custom: true` な room/furniture を温存してマージする。
 *
 * 不動点規則（rev.2）: 配列順は「生成分（マスタの出現順）→ custom 分（既存出力での
 * 出現順）」に固定する。これにより、custom を含む状態で再実行しても出力はバイト同一に
 * 収束する（AC-3）。id が衝突した場合（同じ部署 ID を持つ custom room がある場合）は
 * custom を優先し、警告を返す。furniture には id が無いため衝突判定は行わず、既存の
 * custom furniture をそのまま生成分の末尾に追加する。
 */
export function mergeFloorWithCustom(generated: Floor, existing: Floor | undefined): MergeFloorResult {
  if (!existing) {
    return { floor: generated, warnings: [] };
  }

  const warnings: string[] = [];
  const customRooms = existing.rooms.filter((r) => r.custom === true);
  const customRoomIds = new Set(customRooms.map((r) => r.id));

  const keptGenerated = generated.rooms.filter((room) => {
    if (customRoomIds.has(room.id)) {
      warnings.push(
        `org "${generated.org}": custom room "${room.id}" overrides the generated room with the same id`,
      );
      return false;
    }
    return true;
  });

  const rooms = [...keptGenerated, ...customRooms];

  const customFurniture = existing.furniture.filter((f) => f.custom === true);
  const furniture = [...generated.furniture, ...customFurniture];

  return { floor: { ...generated, rooms, furniture }, warnings };
}

export interface ImportOrganizationsResult {
  layout: OfficeLayout;
  characters: Character[];
  warnings: string[];
  includedOrgIds: string[];
}

/**
 * 既存 Floor から custom な room/furniture だけを取り出した「custom-only floor」を
 * 作る。custom 要素が 1 つも無ければ null（＝温存する理由が無く、正当に削除してよい）。
 */
function orphanCustomOnlyFloor(existingFloor: Floor): Floor | null {
  const customRooms = existingFloor.rooms.filter((r) => r.custom === true);
  const customFurniture = existingFloor.furniture.filter((f) => f.custom === true);
  if (customRooms.length === 0 && customFurniture.length === 0) return null;
  return { ...existingFloor, rooms: customRooms, furniture: customFurniture };
}

/**
 * 複数組織分の masters 入力をまとめて処理し、既存出力（あれば）との custom マージを
 * 行った上で OfficeLayout + Character[] を組み立てる。
 *
 * org は ID の辞書順（codepoint 順。[[compareCodePoint]] 参照）で並べる（fs の
 * readdir 順は OS 依存で非決定的なため、出力のバイト同一性を保証するにはこの正規化が
 * 必要）。1 組織の失敗は他組織を道連れにしない（failures は warnings に記録し、
 * その組織は floors/characters から除外する）。
 *
 * **孤児 floor の温存（Phase 3 レビュー指摘 1 の修正）**: 既存出力にはあるが今回の
 * `orgs` に含まれない（＝マスタから消えた、または今回パースに失敗した）org について、
 * custom な room/furniture が残っている場合は、その custom 分だけを持つ floor として
 * 温存し、warnings に理由を積む。custom 要素が無い孤児 floor は生成分のみなので
 * 黙って削除してよい（silent data loss にならない）。順序は「生成分（今回のマスタ
 * 出現順）→ 孤児の custom-only floor（既存出力での出現順）」に固定し、room/furniture
 * のマージ規則と同じ不動点を保つ（custom-only floor を含む状態で再実行してもバイト
 * 同一になる）。
 */
export function importOrganizations(
  orgs: OrgMastersInput[],
  existingLayout: OfficeLayout | undefined,
): ImportOrganizationsResult {
  const sortedOrgs = [...orgs].sort((a, b) => compareCodePoint(a.orgId, b.orgId));
  const existingFloorsByOrg = new Map((existingLayout?.floors ?? []).map((f) => [f.org, f]));

  const floors: Floor[] = [];
  const characters: Character[] = [];
  const warnings: string[] = [];
  const includedOrgIds: string[] = [];

  for (const org of sortedOrgs) {
    const outcome = buildOrgFloor(org);
    warnings.push(...outcome.warnings);
    if (!outcome.ok) continue;

    const merged = mergeFloorWithCustom(outcome.floor, existingFloorsByOrg.get(org.orgId));
    warnings.push(...merged.warnings);

    floors.push(merged.floor);
    characters.push(...outcome.characters);
    includedOrgIds.push(org.orgId);
  }

  if (existingLayout) {
    const includedOrgIdSet = new Set(includedOrgIds);
    for (const existingFloor of existingLayout.floors) {
      if (includedOrgIdSet.has(existingFloor.org)) continue;
      const orphanFloor = orphanCustomOnlyFloor(existingFloor);
      if (!orphanFloor) continue;
      floors.push(orphanFloor);
      warnings.push(
        `org "${existingFloor.org}" is no longer present in the imported masters, but has custom room/furniture; preserving a custom-only floor`,
      );
    }
  }

  return {
    layout: { version: 1, floors },
    characters,
    warnings,
    includedOrgIds,
  };
}
