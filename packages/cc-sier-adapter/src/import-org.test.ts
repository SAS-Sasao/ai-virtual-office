import { describe, expect, it } from "vitest";
import type { Floor, OfficeLayout } from "@ai-office/protocol";
import {
  DEPARTMENTS_MD,
  DEPARTMENTS_MD_ALL_BROKEN,
  DEPARTMENTS_MD_WITH_STANDBY,
  ORGANIZATION_MD,
  ROLES_MD,
  ROLES_MD_ALT_KEYS,
} from "./fixtures/masters.js";
import {
  GRID_COLS,
  buildOrgFloor,
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

  it("gives every room non-overlapping, in-bounds tile coordinates", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    for (const room of outcome.floor.rooms) {
      expect(room.x).toBeGreaterThanOrEqual(0);
      expect(room.x + room.w).toBeLessThanOrEqual(GRID_COLS);
      expect(room.y).toBeGreaterThanOrEqual(0);
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

  it("places the reception (dept-secretary) room on the bottom-most row", () => {
    const outcome = buildOrgFloor(domainTechInput);
    if (!outcome.ok) throw new Error("expected ok");
    const reception = outcome.floor.rooms.find((r) => r.id === "dept-secretary");
    const maxY = Math.max(...outcome.floor.rooms.map((r) => r.y));
    expect(reception?.y).toBe(maxY);
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

  it("also places a standby department as a room (status: standby, not omitted)", () => {
    const outcome = buildOrgFloor({
      orgId: "domain-tech-collection",
      departmentsMd: DEPARTMENTS_MD_WITH_STANDBY,
      rolesMd: ROLES_MD,
    });
    if (!outcome.ok) throw new Error("expected ok");
    const standby = outcome.floor.rooms.find((r) => r.id === "dept-future-lab");
    expect(standby).toBeDefined();
    expect(standby?.status).toBe("standby");
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

describe("mergeFloorWithCustom", () => {
  const baseFloor: Floor = {
    org: "domain-tech-collection",
    label: "test",
    grid: { cols: 30, rows: 10, tileSize: 32 },
    rooms: [
      { id: "dept-research", name: "技術リサーチ室", status: "active", x: 0, y: 0, w: 8, h: 6, triggers: [] },
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
        { id: "meeting-room-1", name: "会議室", status: "active", x: 20, y: 0, w: 5, h: 5, triggers: [], custom: true },
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
              { id: "dept-old", name: "旧生成部屋", status: "active", x: 0, y: 0, w: 5, h: 6, triggers: [] },
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
              { id: "r", name: "R", status: "active", x: 0, y: 0, w: 5, h: 5, triggers: [], custom: true },
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
});
