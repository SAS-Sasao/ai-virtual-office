import { describe, expect, it } from "vitest";
import type { Character, OfficeLayout, Room } from "@ai-office/protocol";
import { findPath } from "./pathfinding";
import {
  DEFAULT_BACKDROP,
  backdropForOrg,
  RECEPTION_DEPT_ID,
  assignDesks,
  buildFallbackLayout,
  buildRuntimeLayout,
  buildWalkGrid,
  findReceptionRoom,
  findRoomAt,
  resolveEntrance,
  roomInteriorAnchor,
} from "./layout-runtime";
import { REAL_SHAPE_CHARACTERS, REAL_SHAPE_FLOOR } from "./fixtures/real-layout-fixture";

function makeRoom(overrides: Partial<Room> & Pick<Room, "id" | "x" | "y" | "w" | "h" | "door">): Room {
  return {
    name: overrides.id,
    status: "active",
    triggers: [],
    ...overrides,
  };
}

describe("resolveEntrance", () => {
  it("is the tile at the bottom row, horizontally centered", () => {
    const entrance = resolveEntrance(REAL_SHAPE_FLOOR);
    expect(entrance).toEqual({ x: Math.floor(REAL_SHAPE_FLOOR.grid.cols / 2), y: REAL_SHAPE_FLOOR.grid.rows - 1 });
  });
});

describe("findRoomAt", () => {
  it("finds the room containing a given tile", () => {
    const room = findRoomAt(REAL_SHAPE_FLOOR, 3, 3);
    expect(room?.id).toBe("dept-research");
  });

  it("returns undefined for a corridor tile outside all rooms", () => {
    expect(findRoomAt(REAL_SHAPE_FLOOR, 0, 0)).toBeUndefined();
  });
});

describe("buildWalkGrid", () => {
  it("treats room interiors as walkable", () => {
    const grid = buildWalkGrid(REAL_SHAPE_FLOOR);
    // dept-research: x:[1,6) y:[1,7) -> interior は x in (1,5) y in (1,6)
    expect(grid.isWalkable(3, 3)).toBe(true);
  });

  it("treats room boundary tiles (other than the door) as walls", () => {
    const grid = buildWalkGrid(REAL_SHAPE_FLOOR);
    // dept-research の左上角 (1,1) は境界タイルであり door ではない
    expect(grid.isWalkable(1, 1)).toBe(false);
  });

  it("treats the room's door tile as walkable even though it's on the boundary", () => {
    const grid = buildWalkGrid(REAL_SHAPE_FLOOR);
    const door = REAL_SHAPE_FLOOR.rooms.find((r) => r.id === "dept-research")!.door;
    expect(grid.isWalkable(door.x, door.y)).toBe(true);
  });

  it("treats corridor tiles (outside every room) as walkable", () => {
    const grid = buildWalkGrid(REAL_SHAPE_FLOOR);
    expect(grid.isWalkable(0, 0)).toBe(true);
  });

  it("treats out-of-bounds tiles as not walkable", () => {
    const grid = buildWalkGrid(REAL_SHAPE_FLOOR);
    expect(grid.isWalkable(-1, 0)).toBe(false);
    expect(grid.isWalkable(REAL_SHAPE_FLOOR.grid.cols, 0)).toBe(false);
  });
});

describe("findReceptionRoom", () => {
  it("finds the room whose id is dept-secretary", () => {
    const reception = findReceptionRoom(REAL_SHAPE_FLOOR);
    expect(reception?.id).toBe(RECEPTION_DEPT_ID);
  });

  it("returns undefined when no dept-secretary room exists", () => {
    const floorWithoutReception = { ...REAL_SHAPE_FLOOR, rooms: REAL_SHAPE_FLOOR.rooms.filter((r) => r.id !== RECEPTION_DEPT_ID) };
    expect(findReceptionRoom(floorWithoutReception)).toBeUndefined();
  });
});

describe("roomInteriorAnchor", () => {
  it("returns a tile strictly inside the room for a normal-sized room", () => {
    const room = REAL_SHAPE_FLOOR.rooms.find((r) => r.id === "dept-research")!;
    const anchor = roomInteriorAnchor(room);
    expect(anchor.x).toBeGreaterThan(room.x);
    expect(anchor.x).toBeLessThan(room.x + room.w - 1);
    expect(anchor.y).toBeGreaterThan(room.y);
    expect(anchor.y).toBeLessThan(room.y + room.h - 1);
  });

  it("falls back to the door tile for a room too small to have an interior", () => {
    const tinyRoom = makeRoom({ id: "tiny", x: 5, y: 5, w: 2, h: 2, door: { x: 5, y: 6 } });
    expect(roomInteriorAnchor(tinyRoom)).toEqual({ x: 5, y: 6 });
  });
});

describe("assignDesks", () => {
  it("assigns each character to their department's desk in furniture order", () => {
    const desks = assignDesks(REAL_SHAPE_FLOOR, REAL_SHAPE_CHARACTERS);

    expect(desks.get("domain-tech-collection:secretary")).toEqual({ x: 13, y: 10 });
    expect(desks.get("domain-tech-collection:tech-researcher")).toEqual({ x: 2, y: 4 });
    expect(desks.get("domain-tech-collection:retail-domain-researcher")).toEqual({ x: 8, y: 4 });
  });

  it("ignores characters belonging to a different org", () => {
    const foreignCharacter: Character = {
      id: "other-org:role",
      name: "他組織",
      role: "role",
      dept: "dept-research",
      org: "other-org",
    };
    const desks = assignDesks(REAL_SHAPE_FLOOR, [...REAL_SHAPE_CHARACTERS, foreignCharacter]);
    expect(desks.has("other-org:role")).toBe(false);
  });

  it("assigns desks deterministically regardless of input order (same result on repeated calls)", () => {
    const first = assignDesks(REAL_SHAPE_FLOOR, REAL_SHAPE_CHARACTERS);
    const second = assignDesks(REAL_SHAPE_FLOOR, [...REAL_SHAPE_CHARACTERS].reverse());
    for (const character of REAL_SHAPE_CHARACTERS) {
      expect(second.get(character.id)).toEqual(first.get(character.id));
    }
  });

  it("falls back to the room interior anchor when a dept has more characters than desks", () => {
    const extraColleague: Character = {
      id: "domain-tech-collection:extra-researcher",
      name: "追加リサーチャー",
      role: "extra-researcher",
      dept: "dept-research",
      org: "domain-tech-collection",
    };
    const desks = assignDesks(REAL_SHAPE_FLOOR, [...REAL_SHAPE_CHARACTERS, extraColleague]);
    const room = REAL_SHAPE_FLOOR.rooms.find((r) => r.id === "dept-research")!;
    expect(desks.get("domain-tech-collection:extra-researcher")).toEqual(roomInteriorAnchor(room));
  });
});

describe("buildFallbackLayout", () => {
  it("produces a single active room whose door is reachable from the entrance", () => {
    const layout = buildFallbackLayout();
    expect(layout.version).toBe(1);
    expect(layout.floors).toHaveLength(1);

    const floor = layout.floors[0];
    expect(floor.rooms).toHaveLength(1);
    expect(floor.rooms[0].status).toBe("active");

    const grid = buildWalkGrid(floor);
    const entrance = resolveEntrance(floor);
    const door = floor.rooms[0].door;
    const path = findPath(grid, entrance, door);
    expect(path).not.toBeNull();
  });
});

describe("buildRuntimeLayout", () => {
  it("builds one RuntimeFloor per Floor when a real layout is given", () => {
    const layout: OfficeLayout = { version: 1, floors: [REAL_SHAPE_FLOOR] };
    const runtime = buildRuntimeLayout(layout, REAL_SHAPE_CHARACTERS);

    expect(runtime.floors).toHaveLength(1);
    const runtimeFloor = runtime.floors[0];
    expect(runtimeFloor.floor.org).toBe("domain-tech-collection");
    expect(runtimeFloor.entrance).toEqual(resolveEntrance(REAL_SHAPE_FLOOR));
    expect(runtimeFloor.receptionRoom?.id).toBe(RECEPTION_DEPT_ID);
    expect(runtimeFloor.deskByCharacterId.get("domain-tech-collection:secretary")).toEqual({ x: 13, y: 10 });
    expect(runtimeFloor.walkGrid.isWalkable(3, 3)).toBe(true);
  });

  it("falls back to the single-room layout when layout is null", () => {
    const runtime = buildRuntimeLayout(null, []);
    expect(runtime.floors).toHaveLength(1);
    expect(runtime.floors[0].floor.rooms).toHaveLength(1);
  });

  it("every active room's door is reachable from the entrance for the real-shape fixture (AC-3b: game side, fixture-scale)", () => {
    const layout: OfficeLayout = { version: 1, floors: [REAL_SHAPE_FLOOR] };
    const runtime = buildRuntimeLayout(layout, REAL_SHAPE_CHARACTERS);
    const runtimeFloor = runtime.floors[0];

    for (const room of runtimeFloor.floor.rooms.filter((r) => r.status === "active")) {
      const path = findPath(runtimeFloor.walkGrid, runtimeFloor.entrance, room.door);
      expect(path, `room "${room.id}" should be reachable from the entrance`).not.toBeNull();
    }
  });
});

describe("buildRuntimeLayout: default backdrop (M2-2 AC-6)", () => {
  it("applies DEFAULT_BACKDROP to a floor that has no backdrop set", () => {
    const layout: OfficeLayout = { version: 1, floors: [REAL_SHAPE_FLOOR] };
    const runtime = buildRuntimeLayout(layout, []);
    expect(runtime.floors[0].floor.backdrop).toBe(DEFAULT_BACKDROP);
  });

  it("preserves an explicitly-set backdrop instead of overriding it with the default", () => {
    const customFloor = { ...REAL_SHAPE_FLOOR, backdrop: "/assets/backdrops/custom.png" };
    const layout: OfficeLayout = { version: 1, floors: [customFloor] };
    const runtime = buildRuntimeLayout(layout, []);
    expect(runtime.floors[0].floor.backdrop).toBe("/assets/backdrops/custom.png");
  });

  // M2-2 拡張: backdrop を org テーマ別にする（キャラの ORG_THEME と揃える）。
  it("backdropForOrg maps the RPG org to the fantasy room and others to the office room", () => {
    expect(backdropForOrg("jutaku-dev-team")).toBe("/assets/backdrops/fantasy.png");
    expect(backdropForOrg("domain-tech-collection")).toBe(DEFAULT_BACKDROP);
    expect(backdropForOrg("standardization-initiative")).toBe(DEFAULT_BACKDROP);
    expect(backdropForOrg("unknown-org")).toBe(DEFAULT_BACKDROP);
  });

  it("applies the fantasy room backdrop to a jutaku-dev-team (RPG) floor with no backdrop set", () => {
    const rpgFloor = { ...REAL_SHAPE_FLOOR, org: "jutaku-dev-team" };
    const layout: OfficeLayout = { version: 1, floors: [rpgFloor] };
    const runtime = buildRuntimeLayout(layout, []);
    expect(runtime.floors[0].floor.backdrop).toBe("/assets/backdrops/fantasy.png");
  });

  it("does not mutate the input layout's floor (non-destructive spread, F1)", () => {
    const inputFloor: OfficeLayout["floors"][number] = { ...REAL_SHAPE_FLOOR };
    // 入力フロアは backdrop 未設定であることを前提に、buildRuntimeLayout 後も未設定を維持する
    expect(inputFloor.backdrop).toBeUndefined();
    const layout: OfficeLayout = { version: 1, floors: [inputFloor] };
    buildRuntimeLayout(layout, []);
    expect(inputFloor.backdrop).toBeUndefined();
  });
});
