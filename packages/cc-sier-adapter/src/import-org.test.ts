import { describe, expect, it } from "vitest";
import type { Floor, OfficeLayout } from "@ai-office/protocol";
import {
  DEPARTMENTS_MD,
  DEPARTMENTS_MD_ALL_BROKEN,
  DEPARTMENTS_MD_JUTAKU,
  DEPARTMENTS_MD_STANDARDIZATION,
  DEPARTMENTS_MD_WITH_STANDBY,
  ORGANIZATION_MD,
  ORGANIZATION_MD_STANDARDIZATION,
  ROLES_MD,
  ROLES_MD_ALT_KEYS,
  ROLES_MD_JUTAKU,
  ROLES_MD_STANDARDIZATION,
} from "./fixtures/masters.js";
import {
  GRID_COLS,
  buildOrgFloor,
  checkFloorConnectivity,
  importOrganizations,
  mergeFloorWithCustom,
  type OrgMastersInput,
} from "./import-org.js";

const domainTechInput: OrgMastersInput = {
  orgId: "domain-tech-collection",
  organizationMd: ORGANIZATION_MD,
  departmentsMd: DEPARTMENTS_MD,
  rolesMd: ROLES_MD,
};

const jutakuInput: OrgMastersInput = {
  orgId: "jutaku-dev-team",
  departmentsMd: DEPARTMENTS_MD_JUTAKU,
  rolesMd: ROLES_MD_JUTAKU,
};

const standardizationInput: OrgMastersInput = {
  orgId: "standardization-initiative",
  organizationMd: ORGANIZATION_MD_STANDARDIZATION,
  departmentsMd: DEPARTMENTS_MD_STANDARDIZATION,
  rolesMd: ROLES_MD_STANDARDIZATION,
};

describe("buildOrgFloor", () => {
  it("builds a floor with 3 active rooms and 3 characters from the real domain-tech-collection masters", () => {
    const outcome = buildOrgFloor(domainTechInput);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.floor.org).toBe("domain-tech-collection");
    expect(outcome.floor.label).toBe("ドメイン知識や技術スタック収集PJT");
    expect(outcome.floor.rooms).toHaveLength(3);
    expect(outcome.floor.rooms.every((r) => r.status === "active")).toBe(true);
    expect(outcome.characters).toHaveLength(3);
  });

  it("fixes the grid width to GRID_COLS regardless of content", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.floor.grid.cols).toBe(GRID_COLS);
    expect(GRID_COLS).toBe(30);
  });

  it("gives every room non-overlapping, in-bounds tile coordinates, reserved inside a 1-tile outer corridor margin", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    for (const room of outcome.floor.rooms) {
      expect(room.x).toBeGreaterThanOrEqual(1); // 左 1 タイルは外周廊下
      expect(room.x + room.w).toBeLessThanOrEqual(GRID_COLS - 1); // 右 1 タイルは外周廊下
      expect(room.y).toBeGreaterThanOrEqual(1); // 上 1 タイルは外周廊下
    }
    // 矩形が重ならないこと（同じ行に並ぶ部屋同士の x レンジが重複しない）
    const byRow = new Map<number, typeof outcome.floor.rooms>();
    for (const room of outcome.floor.rooms) {
      const arr = byRow.get(room.y) ?? [];
      arr.push(room);
      byRow.set(room.y, arr);
    }
    for (const rooms of byRow.values()) {
      const sorted = [...rooms].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w);
      }
    }
  });

  it("computes a door on each room's bottom edge, positioned within the room's own width and facing a tile that no room occupies (a corridor tile)", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    for (const room of outcome.floor.rooms) {
      expect(room.door.y).toBe(room.y + room.h - 1); // 下辺
      expect(room.door.x).toBeGreaterThanOrEqual(room.x);
      expect(room.door.x).toBeLessThan(room.x + room.w);

      const belowY = room.door.y + 1;
      const belowIsCorridor = !outcome.floor.rooms.some(
        (other) => room.door.x >= other.x && room.door.x < other.x + other.w && belowY >= other.y && belowY < other.y + other.h,
      );
      expect(belowIsCorridor).toBe(true);
    }
  });

  it("places the reception (dept-secretary) room on the bottom-most row, at a proportional (not full-floor) width", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    const reception = outcome.floor.rooms.find((r) => r.id === "dept-secretary");
    const maxY = Math.max(...outcome.floor.rooms.map((r) => r.y));
    expect(reception?.y).toBe(maxY);
    expect(reception?.w).toBeLessThan(GRID_COLS); // rev.2: 受付はもう全幅ではない
    expect(reception?.x).toBeGreaterThan(0); // 全幅でないなら左端 0 に張り付かない
  });

  it("satisfies the connectivity invariant: the entrance (bottom-most row, centered) reaches every active room's interior via its door", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    const result = checkFloorConnectivity(outcome.floor);
    expect(result).toEqual({ ok: true, unreachableRoomIds: [] });
  });

  it("places one desk furniture item per role, inside that role's department room bounds", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.floor.furniture).toHaveLength(3);
    expect(outcome.floor.furniture.every((f) => f.kind === "desk")).toBe(true);
    const researchRoom = outcome.floor.rooms.find((r) => r.id === "dept-research")!;
    const researchDesk = outcome.floor.furniture.find(
      (f) => f.x >= researchRoom.x && f.x < researchRoom.x + researchRoom.w && f.y >= researchRoom.y && f.y < researchRoom.y + researchRoom.h,
    );
    expect(researchDesk).toBeDefined();
  });

  it("builds characters with org-qualified ids (avoids cross-org id collisions)", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    const secretary = outcome.characters.find((c) => c.role === "secretary");
    expect(secretary?.id).toBe("domain-tech-collection:secretary");
    expect(secretary?.org).toBe("domain-tech-collection");
    expect(secretary?.dept).toBe("dept-secretary");
    expect(secretary?.model).toBe("opus");
  });

  it("also places a standby department as a room (status: standby, not omitted), with a door of its own", () => {
    const outcome = buildOrgFloor({
      orgId: "domain-tech-collection",
      departmentsMd: DEPARTMENTS_MD_WITH_STANDBY,
      rolesMd: ROLES_MD,
    });
    if (!outcome.ok) throw new Error("expected ok");
    const standby = outcome.floor.rooms.find((r) => r.id === "dept-future-lab");
    expect(standby).toBeDefined();
    expect(standby?.status).toBe("standby");
    expect(standby?.door).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  });

  it("falls back the floor label to the org id when organization.md is absent", () => {
    const outcome = buildOrgFloor({
      orgId: "domain-tech-collection",
      departmentsMd: DEPARTMENTS_MD,
      rolesMd: ROLES_MD,
    });
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.floor.label).toBe("domain-tech-collection");
  });

  it("handles the roles.md key-variant fixture (所属部署/model) without error and assigns the same dept", () => {
    const outcome = buildOrgFloor({
      orgId: "jutaku-dev-team",
      departmentsMd: `## dept-secretary\n\n- **名称**: 秘書室\n- **ステータス**: active\n\n## dept-pm\n\n- **名称**: プロジェクト管理室\n- **ステータス**: active\n`,
      rolesMd: ROLES_MD_ALT_KEYS,
    });
    if (!outcome.ok) throw new Error("expected ok");
    const pm = outcome.characters.find((c) => c.role === "project-manager");
    expect(pm?.dept).toBe("dept-pm");
    expect(pm?.model).toBe("sonnet");
  });

  it("returns ok:false with warnings when departments.md is missing", () => {
    const outcome = buildOrgFloor({ orgId: "broken-org", rolesMd: ROLES_MD });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.warnings.some((w) => w.includes("departments.md"))).toBe(true);
  });

  it("returns ok:false when every department section is broken (0 valid departments)", () => {
    const outcome = buildOrgFloor({ orgId: "broken-org", departmentsMd: DEPARTMENTS_MD_ALL_BROKEN });
    expect(outcome.ok).toBe(false);
  });

  it("does not include time or randomness: two calls with identical input produce deep-equal results", () => {
    const a = buildOrgFloor(domainTechInput);
    const b = buildOrgFloor(domainTechInput);
    expect(a).toEqual(b);
  });
});

describe("checkFloorConnectivity", () => {
  it("passes (ok:true, no unreachable rooms) for a floor generated from the real domain-tech-collection masters", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    expect(checkFloorConnectivity(outcome.floor)).toEqual({ ok: true, unreachableRoomIds: [] });
  });

  it("reports an active room as unreachable when its door does not actually face a corridor tile (boxed in by a neighboring room)", () => {
    // 手作りの壊れたフロア: dept-a の door(3,6) の直下 (3,7) を dept-b が覆っており、
    // 廊下に面していない（連結性契約違反）。
    const brokenFloor: Floor = {
      org: "broken",
      label: "broken",
      grid: { cols: 10, rows: 10, tileSize: 32 },
      rooms: [
        { id: "dept-a", name: "A", status: "active", x: 1, y: 1, w: 5, h: 6, triggers: [], door: { x: 3, y: 6 } },
        { id: "dept-b", name: "B", status: "active", x: 1, y: 7, w: 5, h: 2, triggers: [], door: { x: 3, y: 8 } },
      ],
      furniture: [],
    };
    const result = checkFloorConnectivity(brokenFloor);
    expect(result.ok).toBe(false);
    expect(result.unreachableRoomIds).toContain("dept-a");
  });

  it("reports an active room as unreachable when its door sits in a corner (door tile itself is reachable, but no orthogonal step leads into the room's interior)", () => {
    // Phase 3 レビュー指摘 2（low）への対応: door 到達だけを見ていると、door が
    // 部屋の「角」に来た場合（例: computeDoor の防御的フォールバックが角を返した場合）を
    // 見逃す。角タイルは 4 近傍のどの方向にも「内部」へ踏み込めない
    // （上下左右のいずれも境界壁か部屋の外）ため、door 自体は廊下から visited になって
    // も部屋の内部は完全に閉じたままになりうる。
    //
    // dept-corner: x:[1,6) y:[1,6)（内部は x:[2,5) y:[2,5)）。door を左下角 (1,5) に
    // 手動で置く（本来 computeDoor は中央優先で角を避けるが、契約違反の手作りデータで
    // 「door 到達 = 内部到達」という誤った前提を検証する）。
    const cornerDoorFloor: Floor = {
      org: "corner-door",
      label: "corner-door",
      grid: { cols: 10, rows: 10, tileSize: 32 },
      rooms: [
        { id: "dept-corner", name: "Corner", status: "active", x: 1, y: 1, w: 5, h: 5, triggers: [], door: { x: 1, y: 5 } },
      ],
      furniture: [],
    };

    const result = checkFloorConnectivity(cornerDoorFloor);
    expect(result.ok).toBe(false);
    expect(result.unreachableRoomIds).toContain("dept-corner");
  });

  it("ignores standby rooms when deciding reachability (a standby room with an unreachable door does not fail the check)", () => {
    const floor: Floor = {
      org: "standby-only",
      label: "standby-only",
      grid: { cols: 10, rows: 10, tileSize: 32 },
      rooms: [
        {
          id: "dept-standby",
          name: "休止室",
          status: "standby",
          x: 1,
          y: 1,
          w: 5,
          h: 2,
          triggers: [],
          door: { x: 3, y: 2 }, // 直下 (3,3) は grid 外周だが standby なので判定対象外
        },
      ],
      furniture: [],
    };
    const result = checkFloorConnectivity(floor);
    expect(result).toEqual({ ok: true, unreachableRoomIds: [] });
  });
});

describe("mergeFloorWithCustom", () => {
  const baseFloor: Floor = {
    org: "domain-tech-collection",
    label: "test",
    grid: { cols: 30, rows: 10, tileSize: 32 },
    rooms: [
      {
        id: "dept-research",
        name: "技術リサーチ室",
        status: "active",
        x: 0,
        y: 0,
        w: 8,
        h: 6,
        triggers: [],
        door: { x: 4, y: 5 },
      },
    ],
    furniture: [{ kind: "desk", x: 1, y: 1 }],
  };

  it("returns the generated floor unchanged when there is no existing floor", () => {
    const { floor, warnings } = mergeFloorWithCustom(baseFloor, undefined);
    expect(floor).toEqual(baseFloor);
    expect(warnings).toEqual([]);
  });

  it("preserves a custom room that does not collide with any generated room id", () => {
    const existing: Floor = {
      ...baseFloor,
      rooms: [
        ...baseFloor.rooms,
        {
          id: "meeting-room-1",
          name: "会議室（手動追加）",
          status: "active",
          x: 20,
          y: 0,
          w: 5,
          h: 5,
          triggers: [],
          door: { x: 22, y: 4 },
          custom: true,
        },
      ],
    };
    const { floor, warnings } = mergeFloorWithCustom(baseFloor, existing);
    expect(floor.rooms.map((r) => r.id)).toEqual(["dept-research", "meeting-room-1"]);
    expect(warnings).toEqual([]);
  });

  it("prefers a custom room over a generated room with the same id, and warns", () => {
    const existing: Floor = {
      ...baseFloor,
      rooms: [
        { ...baseFloor.rooms[0], name: "手動で名前を変えた部屋", w: 20, custom: true },
      ],
    };
    const { floor, warnings } = mergeFloorWithCustom(baseFloor, existing);
    expect(floor.rooms).toHaveLength(1);
    expect(floor.rooms[0]).toMatchObject({ id: "dept-research", name: "手動で名前を変えた部屋", w: 20, custom: true });
    expect(warnings.some((w) => w.includes("dept-research"))).toBe(true);
  });

  it("drops existing rooms that are not flagged custom (they were generated last run, and are superseded by the new generation)", () => {
    const existing: Floor = {
      ...baseFloor,
      rooms: [{ ...baseFloor.rooms[0], name: "旧世代の生成物", w: 99 }], // custom フラグ無し
    };
    const { floor } = mergeFloorWithCustom(baseFloor, existing);
    expect(floor.rooms).toEqual(baseFloor.rooms);
  });

  it("keeps custom furniture (no id, kept verbatim) alongside freshly generated furniture", () => {
    const existing: Floor = {
      ...baseFloor,
      furniture: [{ kind: "plant", x: 15, y: 3, custom: true }],
    };
    const { floor } = mergeFloorWithCustom(baseFloor, existing);
    expect(floor.furniture).toEqual([...baseFloor.furniture, { kind: "plant", x: 15, y: 3, custom: true }]);
  });

  it("is a fixed point: merging an already-merged (normalized) floor with itself again produces the same result", () => {
    const existing: Floor = {
      ...baseFloor,
      rooms: [
        ...baseFloor.rooms,
        {
          id: "meeting-room-1",
          name: "会議室",
          status: "active",
          x: 20,
          y: 0,
          w: 5,
          h: 5,
          triggers: [],
          door: { x: 22, y: 4 },
          custom: true,
        },
      ],
    };
    const once = mergeFloorWithCustom(baseFloor, existing);
    const twice = mergeFloorWithCustom(baseFloor, once.floor);
    expect(twice.floor).toEqual(once.floor);
  });
});

describe("importOrganizations", () => {
  it("aggregates multiple orgs into floors sorted by org id, for deterministic output", () => {
    const result = importOrganizations(
      [
        { orgId: "zzz-org", departmentsMd: DEPARTMENTS_MD, rolesMd: ROLES_MD },
        { orgId: "aaa-org", departmentsMd: DEPARTMENTS_MD, rolesMd: ROLES_MD },
      ],
      undefined,
    );
    expect(result.layout.floors.map((f) => f.org)).toEqual(["aaa-org", "zzz-org"]);
    expect(result.layout.version).toBe(1);
  });

  it("excludes an org that fails entirely, but keeps the others (partial continuation across orgs)", () => {
    const result = importOrganizations(
      [
        { orgId: "good-org", departmentsMd: DEPARTMENTS_MD, rolesMd: ROLES_MD },
        { orgId: "bad-org", departmentsMd: DEPARTMENTS_MD_ALL_BROKEN },
      ],
      undefined,
    );
    expect(result.layout.floors.map((f) => f.org)).toEqual(["good-org"]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns an empty floors array (not a throw) when every org fails", () => {
    const result = importOrganizations([{ orgId: "bad-org", departmentsMd: DEPARTMENTS_MD_ALL_BROKEN }], undefined);
    expect(result.layout.floors).toEqual([]);
  });

  it("produces byte-for-byte identical output across two runs with the same input (idempotency, AC-3)", () => {
    const orgs: OrgMastersInput[] = [domainTechInput];
    const first = importOrganizations(orgs, undefined);
    const second = importOrganizations(orgs, first.layout);
    expect(JSON.stringify(second.layout)).toBe(JSON.stringify(first.layout));
    expect(JSON.stringify(second.characters)).toBe(JSON.stringify(first.characters));
  });

  it("stays at a fixed point across repeated runs once a custom room has been injected (AC-3)", () => {
    const orgs: OrgMastersInput[] = [domainTechInput];
    const generated = importOrganizations(orgs, undefined);
    const withCustom: OfficeLayout = {
      ...generated.layout,
      floors: generated.layout.floors.map((f) =>
        f.org === "domain-tech-collection"
          ? {
              ...f,
              rooms: [
                ...f.rooms,
                {
                  id: "lounge",
                  name: "談話室（手動追加）",
                  status: "active" as const,
                  x: 0,
                  y: 20,
                  w: 6,
                  h: 4,
                  triggers: [],
                  door: { x: 3, y: 23 },
                  custom: true,
                },
              ],
            }
          : f,
      ),
    };

    const run2 = importOrganizations(orgs, withCustom);
    const run3 = importOrganizations(orgs, run2.layout);
    expect(JSON.stringify(run3.layout)).toBe(JSON.stringify(run2.layout));
    expect(run2.layout.floors.find((f) => f.org === "domain-tech-collection")?.rooms.map((r) => r.id)).toContain(
      "lounge",
    );
  });

  // Phase 3 レビュー指摘 1（medium）: マスタから消えた org（ghost-org）に custom
  // 要素が残っている場合、無警告で消してはいけない（FR-3 の custom 温存に反する
  // silent data loss）。
  describe("orphaned floors (org removed from masters but custom content exists in the previous output)", () => {
    const minimalDepartmentsMd = `## dept-x\n\n- **名称**: X室\n- **ステータス**: active\n`;

    it("preserves a custom-only floor for an org no longer present in masters, and warns", () => {
      const existingLayout: OfficeLayout = {
        version: 1,
        floors: [
          {
            org: "ghost-org",
            label: "消えた組織",
            grid: { cols: 30, rows: 10, tileSize: 32 },
            rooms: [
              {
                id: "dept-old",
                name: "旧生成部屋（custom 無し）",
                status: "active",
                x: 0,
                y: 0,
                w: 5,
                h: 6,
                triggers: [],
                door: { x: 2, y: 5 },
              },
              {
                id: "meeting-room-1",
                name: "会議室（手動追加）",
                status: "active",
                x: 6,
                y: 0,
                w: 5,
                h: 5,
                triggers: [],
                door: { x: 8, y: 4 },
                custom: true,
              },
            ],
            furniture: [
              { kind: "desk", x: 1, y: 1 },
              { kind: "plant", x: 10, y: 1, custom: true },
            ],
          },
        ],
      };

      const result = importOrganizations(
        [{ orgId: "domain-tech-collection", departmentsMd: minimalDepartmentsMd }],
        existingLayout,
      );

      const ghostFloor = result.layout.floors.find((f) => f.org === "ghost-org");
      expect(ghostFloor).toBeDefined();
      // custom 無しの旧生成部屋は落ち、custom 分だけが残る
      expect(ghostFloor?.rooms).toEqual([
        {
          id: "meeting-room-1",
          name: "会議室（手動追加）",
          status: "active",
          x: 6,
          y: 0,
          w: 5,
          h: 5,
          triggers: [],
          door: { x: 8, y: 4 },
          custom: true,
        },
      ]);
      expect(ghostFloor?.furniture).toEqual([{ kind: "plant", x: 10, y: 1, custom: true }]);
      expect(result.warnings.some((w) => w.includes("ghost-org"))).toBe(true);
    });

    it("drops an orphaned floor entirely (no warning needed) when it has no custom room/furniture", () => {
      const existingLayout: OfficeLayout = {
        version: 1,
        floors: [
          {
            org: "ghost-org",
            label: "消えた組織",
            grid: { cols: 30, rows: 10, tileSize: 32 },
            rooms: [
              {
                id: "dept-old",
                name: "旧生成部屋",
                status: "active",
                x: 0,
                y: 0,
                w: 5,
                h: 6,
                triggers: [],
                door: { x: 2, y: 5 },
              },
            ],
            furniture: [{ kind: "desk", x: 1, y: 1 }],
          },
        ],
      };

      const result = importOrganizations(
        [{ orgId: "domain-tech-collection", departmentsMd: minimalDepartmentsMd }],
        existingLayout,
      );

      expect(result.layout.floors.find((f) => f.org === "ghost-org")).toBeUndefined();
      expect(result.warnings.some((w) => w.includes("ghost-org"))).toBe(false);
    });

    it("also preserves custom content for an org that is present in masters this run but fails to parse (same code path as a fully-removed org)", () => {
      const existingLayout: OfficeLayout = {
        version: 1,
        floors: [
          {
            org: "broken-org",
            label: "壊れた組織",
            grid: { cols: 30, rows: 10, tileSize: 32 },
            rooms: [
              {
                id: "shrine",
                name: "手動の部屋",
                status: "active",
                x: 0,
                y: 0,
                w: 5,
                h: 5,
                triggers: [],
                door: { x: 2, y: 4 },
                custom: true,
              },
            ],
            furniture: [],
          },
        ],
      };

      const result = importOrganizations(
        [
          { orgId: "domain-tech-collection", departmentsMd: minimalDepartmentsMd },
          { orgId: "broken-org", departmentsMd: DEPARTMENTS_MD_ALL_BROKEN },
        ],
        existingLayout,
      );

      const brokenFloor = result.layout.floors.find((f) => f.org === "broken-org");
      expect(brokenFloor?.rooms.map((r) => r.id)).toEqual(["shrine"]);
      expect(result.warnings.some((w) => w.includes("broken-org"))).toBe(true);
    });

    it("is a fixed point: the preserved custom-only floor stays byte-identical across repeated runs", () => {
      const orgs: OrgMastersInput[] = [{ orgId: "domain-tech-collection", departmentsMd: minimalDepartmentsMd }];
      const existingLayout: OfficeLayout = {
        version: 1,
        floors: [
          {
            org: "ghost-org",
            label: "消えた組織",
            grid: { cols: 30, rows: 10, tileSize: 32 },
            rooms: [
              {
                id: "meeting-room-1",
                name: "会議室（手動追加）",
                status: "active",
                x: 0,
                y: 0,
                w: 5,
                h: 5,
                triggers: [],
                door: { x: 2, y: 4 },
                custom: true,
              },
            ],
            furniture: [],
          },
        ],
      };

      const run1 = importOrganizations(orgs, existingLayout);
      const run2 = importOrganizations(orgs, run1.layout);
      expect(JSON.stringify(run2.layout)).toBe(JSON.stringify(run1.layout));
      expect(run2.layout.floors.map((f) => f.org)).toContain("ghost-org");
    });

    it("places preserved orphan floors after the freshly generated floors (fixed floor-ordering convention: generated → orphan-custom, matching the room/furniture merge rule)", () => {
      const orgs: OrgMastersInput[] = [
        { orgId: "zzz-org", departmentsMd: minimalDepartmentsMd },
        { orgId: "aaa-org", departmentsMd: minimalDepartmentsMd },
      ];
      const existingLayout: OfficeLayout = {
        version: 1,
        floors: [
          {
            org: "ghost-org",
            label: "消えた組織",
            grid: { cols: 30, rows: 10, tileSize: 32 },
            rooms: [
              {
                id: "r",
                name: "R",
                status: "active",
                x: 0,
                y: 0,
                w: 5,
                h: 5,
                triggers: [],
                door: { x: 2, y: 4 },
                custom: true,
              },
            ],
            furniture: [],
          },
        ],
      };

      const result = importOrganizations(orgs, existingLayout);
      expect(result.layout.floors.map((f) => f.org)).toEqual(["aaa-org", "zzz-org", "ghost-org"]);
    });
  });

  // Phase 3 レビュー指摘 2（low）: org id の並び替えは String.prototype.localeCompare
  // ではなく、既定の Array.prototype.sort()（codepoint/UTF-16 コード単位比較）と
  // 同じ規則で行う。localeCompare は実行環境のロケール設定に依存し、大文字や `_` を
  // 含む org id で discoverOrgs / branchOrgs（既定 .sort()）と順序が食い違いうる
  // （決定論性が崩れる = AC-3 の前提が崩れる）。
  it("sorts floors by codepoint order, not locale order (regression: 'a_z'/'a-z'/'B-y' sort differently under localeCompare than under the default Array.sort())", () => {
    const minimalDepartmentsMd = `## dept-x\n\n- **名称**: X室\n- **ステータス**: active\n`;
    const ids = ["a_z", "a-z", "B-y"];
    // 事前条件の確認: この 3 つの id は localeCompare と codepoint 順で実際に食い違う
    expect([...ids].sort((a, b) => a.localeCompare(b))).not.toEqual([...ids].sort());

    const result = importOrganizations(
      ids.map((orgId) => ({ orgId, departmentsMd: minimalDepartmentsMd })),
      undefined,
    );
    expect(result.layout.floors.map((f) => f.org)).toEqual([...ids].sort());
  });

  // M1-4a rev.2 F1: 3 実組織すべてで「入口 → 全 active 部屋」が到達可能であること
  // （生成時不変条件 checkFloorConnectivity の adapter unit テスト、AC-3b①）。
  describe("connectivity across the 3 real organizations (AC-3b)", () => {
    const result = importOrganizations([domainTechInput, jutakuInput, standardizationInput], undefined);

    it("produces one floor per organization", () => {
      expect(result.layout.floors.map((f) => f.org).sort()).toEqual([
        "domain-tech-collection",
        "jutaku-dev-team",
        "standardization-initiative",
      ]);
    });

    it("keeps every floor within GRID_COLS (30 columns)", () => {
      for (const floor of result.layout.floors) {
        expect(floor.grid.cols).toBe(GRID_COLS);
        for (const room of floor.rooms) {
          expect(room.x + room.w).toBeLessThanOrEqual(GRID_COLS);
        }
      }
    });

    it("makes every active room reachable from the entrance via its door, on every floor", () => {
      for (const floor of result.layout.floors) {
        const connectivity = checkFloorConnectivity(floor);
        expect(connectivity).toEqual({ ok: true, unreachableRoomIds: [] });
      }
    });

    it("never places the reception (dept-secretary) room at full floor width", () => {
      for (const floor of result.layout.floors) {
        const reception = floor.rooms.find((r) => r.id === "dept-secretary");
        expect(reception).toBeDefined();
        expect(reception!.w).toBeLessThan(GRID_COLS);
      }
    });
  });
});
