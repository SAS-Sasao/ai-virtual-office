import { describe, expect, it } from "vitest";
import {
  CharacterSchema,
  FloorSchema,
  FurnitureSchema,
  OfficeLayoutSchema,
  RoomSchema,
  type Character,
  type Floor,
  type Furniture,
  type OfficeLayout,
  type Room,
} from "./layout.js";

describe("CharacterSchema", () => {
  const valid = {
    id: "domain-tech-collection:tech-researcher",
    name: "テクニカルリサーチャー",
    role: "tech-researcher",
    dept: "dept-research",
    org: "domain-tech-collection",
  };

  it("parses a minimal valid character (model omitted)", () => {
    const result = CharacterSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("parses a character with model", () => {
    const input = { ...valid, model: "sonnet" };
    const result = CharacterSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("rejects a character missing a required field (org)", () => {
    const { org: _org, ...rest } = valid;
    const result = CharacterSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an empty id", () => {
    const result = CharacterSchema.safeParse({ ...valid, id: "" });
    expect(result.success).toBe(false);
  });

  it("strips unknown keys, including a stray 'session' field (rev.2: no runtime session state on the static Character record)", () => {
    const input = { ...valid, session: { state: "idle" }, sprite: "custom.png" };
    const result = CharacterSchema.parse(input);
    expect(Object.keys(result).sort()).toEqual(["dept", "id", "name", "org", "role"]);
    expect(result).not.toHaveProperty("session");
    expect(result).not.toHaveProperty("sprite");
  });

  it("infers a Character type usable as a literal", () => {
    const character: Character = valid;
    expect(CharacterSchema.safeParse(character).success).toBe(true);
  });
});

describe("RoomSchema", () => {
  const valid = {
    id: "dept-research",
    name: "技術リサーチ室",
    status: "active",
    x: 6,
    y: 0,
    w: 11,
    h: 6,
    triggers: ["調査", "リサーチ"],
    door: { x: 11, y: 5 },
  };

  it("parses a minimal valid room (custom omitted)", () => {
    const result = RoomSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("rejects a room missing door (M1-4a: door is a required field — the connectivity contract room↔corridor, guaranteed by cc-sier-adapter at generation time; see doc comment)", () => {
    const { door: _door, ...rest } = valid;
    const result = RoomSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a door with non-integer coordinates", () => {
    const result = RoomSchema.safeParse({ ...valid, door: { x: 1.5, y: 0 } });
    expect(result.success).toBe(false);
  });

  it("rejects a door with a negative coordinate", () => {
    const result = RoomSchema.safeParse({ ...valid, door: { x: -1, y: 0 } });
    expect(result.success).toBe(false);
  });

  it("parses a standby room", () => {
    const input = { ...valid, status: "standby" };
    const result = RoomSchema.parse(input);
    expect(result.status).toBe("standby");
  });

  it("parses a room with custom: true", () => {
    const input = { ...valid, custom: true };
    const result = RoomSchema.parse(input);
    expect(result.custom).toBe(true);
  });

  it("rejects a status outside active|standby", () => {
    const result = RoomSchema.safeParse({ ...valid, status: "closed" });
    expect(result.success).toBe(false);
  });

  it("accepts an empty triggers array", () => {
    const result = RoomSchema.safeParse({ ...valid, triggers: [] });
    expect(result.success).toBe(true);
  });

  it("rejects non-integer tile coordinates", () => {
    const result = RoomSchema.safeParse({ ...valid, x: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive width", () => {
    const result = RoomSchema.safeParse({ ...valid, w: 0 });
    expect(result.success).toBe(false);
  });

  it("strips unknown keys", () => {
    const input = { ...valid, doorLocked: true };
    const result = RoomSchema.parse(input);
    expect(result).not.toHaveProperty("doorLocked");
  });

  it("infers a Room type usable as a literal", () => {
    const room: Room = valid as Room;
    expect(RoomSchema.safeParse(room).success).toBe(true);
  });
});

describe("FurnitureSchema", () => {
  const valid = { kind: "desk", x: 7, y: 1 };

  it("parses a minimal valid furniture item (custom omitted)", () => {
    const result = FurnitureSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("parses a furniture item with custom: true", () => {
    const input = { ...valid, custom: true };
    const result = FurnitureSchema.parse(input);
    expect(result.custom).toBe(true);
  });

  it("rejects an empty kind", () => {
    const result = FurnitureSchema.safeParse({ ...valid, kind: "" });
    expect(result.success).toBe(false);
  });

  it("strips unknown keys", () => {
    const input = { ...valid, sprite: "desk-2.png" };
    const result = FurnitureSchema.parse(input);
    expect(result).not.toHaveProperty("sprite");
  });

  it("infers a Furniture type usable as a literal", () => {
    const furniture: Furniture = valid;
    expect(FurnitureSchema.safeParse(furniture).success).toBe(true);
  });
});

describe("FloorSchema", () => {
  const valid = {
    org: "domain-tech-collection",
    label: "ドメイン知識や技術スタック収集PJT",
    grid: { cols: 30, rows: 12, tileSize: 32 },
    rooms: [
      {
        id: "dept-research",
        name: "技術リサーチ室",
        status: "active",
        x: 0,
        y: 0,
        w: 11,
        h: 6,
        triggers: ["調査"],
        door: { x: 5, y: 5 },
      },
    ],
    furniture: [{ kind: "desk", x: 1, y: 1 }],
  };

  it("parses a minimal valid floor (backdrop omitted)", () => {
    const result = FloorSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("parses a floor with a backdrop", () => {
    const input = { ...valid, backdrop: "floor-1.png" };
    const result = FloorSchema.parse(input);
    expect(result.backdrop).toBe("floor-1.png");
  });

  it("accepts empty rooms/furniture arrays", () => {
    const result = FloorSchema.safeParse({ ...valid, rooms: [], furniture: [] });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid nested room (bad status)", () => {
    const badRoom = { ...valid.rooms[0], status: "closed" };
    const result = FloorSchema.safeParse({ ...valid, rooms: [badRoom] });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid nested room (missing door)", () => {
    const { door: _door, ...badRoom } = valid.rooms[0];
    const result = FloorSchema.safeParse({ ...valid, rooms: [badRoom] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive grid dimension", () => {
    const result = FloorSchema.safeParse({ ...valid, grid: { ...valid.grid, cols: 0 } });
    expect(result.success).toBe(false);
  });

  it("strips unknown top-level keys", () => {
    const input = { ...valid, wallpaper: "blue" };
    const result = FloorSchema.parse(input);
    expect(result).not.toHaveProperty("wallpaper");
  });

  it("infers a Floor type usable as a literal", () => {
    const floor: Floor = valid as Floor;
    expect(FloorSchema.safeParse(floor).success).toBe(true);
  });
});

describe("OfficeLayoutSchema", () => {
  const validFloor = {
    org: "domain-tech-collection",
    label: "ドメイン知識や技術スタック収集PJT",
    grid: { cols: 30, rows: 12, tileSize: 32 },
    rooms: [],
    furniture: [],
  };

  it("parses a minimal valid layout", () => {
    const input = { version: 1, floors: [validFloor] };
    const result = OfficeLayoutSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("accepts an empty floors array", () => {
    const result = OfficeLayoutSchema.safeParse({ version: 1, floors: [] });
    expect(result.success).toBe(true);
  });

  it("rejects a version other than 1", () => {
    const result = OfficeLayoutSchema.safeParse({ version: 2, floors: [] });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid nested floor", () => {
    const result = OfficeLayoutSchema.safeParse({
      version: 1,
      floors: [{ ...validFloor, org: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown top-level keys", () => {
    const input = { version: 1, floors: [validFloor], generatedAt: "2026-07-25" };
    const result = OfficeLayoutSchema.parse(input);
    expect(result).not.toHaveProperty("generatedAt");
  });

  it("infers an OfficeLayout type usable as a literal", () => {
    const layout: OfficeLayout = { version: 1, floors: [validFloor as Floor] };
    expect(OfficeLayoutSchema.safeParse(layout).success).toBe(true);
  });
});
