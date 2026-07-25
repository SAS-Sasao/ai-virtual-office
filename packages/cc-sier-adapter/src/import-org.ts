// masters/*.md（の文字列内容）→ OfficeLayout + Character[] を生成する純関数。
// fs には一切触れない（走査は cli.ts の責務）。
//
// 決定論性: 出力に乱数・時刻を一切含めない。同じ入力（masters 文字列 + 既存出力）からは
// 常に同じバイト列が得られる（AC-3）。レイアウト自動生成のアルゴリズムはこのファイル内の
// 定数（GRID_COLS 等）に閉じ込め、値そのものは設計メモが明示していないため実装判断として
// ここで固定する（グリッド幅 30 タイル・行優先・部屋幅はロール数比例、という制約は遵守）。
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
const ROOM_HEIGHT = 6;
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

/**
 * 1 組織分の masters 文字列から Floor + Character[] を生成する。
 *
 * - departments.md が無い、または有効な部署が 0 件の場合は ok:false を返す
 *   （import-org.ts レベルでは「その組織を除外」の判断のみ行い、CLI 全体としての
 *   graceful degradation 判定は cli.ts が全組織の結果を見て行う）
 * - 部署はマスタの出現順（行優先）でグリッド幅 GRID_COLS 内に配置する。部屋幅は
 *   所属ロール数に比例させる。dept-secretary は受付として最下段に固定配置する
 * - standby 部署も部屋として配置する（描画側が消灯表現に使う。要件 §2.1）
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

  const rooms: Room[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowUsed = false;

  for (const dept of others) {
    const roleCount = roleCountByDept.get(dept.id) ?? 0;
    const width = roomWidthFor(roleCount);
    if (rowUsed && cursorX + width > GRID_COLS) {
      cursorX = 0;
      cursorY += ROOM_HEIGHT + ROOM_GAP;
      rowUsed = false;
    }
    rooms.push({
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
    const receptionY = rowUsed ? cursorY + ROOM_HEIGHT + ROOM_GAP : 0;
    rooms.push({
      id: reception.id,
      name: reception.name,
      status: reception.status,
      x: 0,
      y: receptionY,
      w: GRID_COLS,
      h: RECEPTION_HEIGHT,
      triggers: reception.triggers,
    });
  } else {
    warnings.push(`${orgTag}: no "${RECEPTION_ID}" department found (reception room omitted)`);
  }

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
    grid: { cols: GRID_COLS, rows: maxBottom + ROOM_GAP, tileSize: DEFAULT_TILE_SIZE },
    rooms,
    furniture,
  });

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
