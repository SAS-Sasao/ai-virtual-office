import { describe, expect, it } from "vitest";
import { findPath, type Tile, type WalkGrid } from "./pathfinding";

/** 全タイルが歩行可能な cols x rows の開けたグリッド。 */
function openGrid(cols: number, rows: number): WalkGrid {
  return {
    cols,
    rows,
    isWalkable: (x: number, y: number) => x >= 0 && x < cols && y >= 0 && y < rows,
  };
}

/** blocked に含まれるタイルだけ歩行不可にした cols x rows のグリッド。 */
function gridWithWalls(cols: number, rows: number, blocked: ReadonlySet<string>): WalkGrid {
  return {
    cols,
    rows,
    isWalkable: (x: number, y: number) => {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return false;
      return !blocked.has(`${x},${y}`);
    },
  };
}

function tileKeys(path: Tile[] | null): string[] | null {
  return path ? path.map((t) => `${t.x},${t.y}`) : null;
}

describe("findPath (BFS, 4-neighbor)", () => {
  it("finds the shortest path length in an open grid (manhattan distance + 1 tiles)", () => {
    const grid = openGrid(10, 10);
    const path = findPath(grid, { x: 0, y: 0 }, { x: 3, y: 4 });

    expect(path).not.toBeNull();
    // マンハッタン距離 = 3 + 4 = 7 移動 → タイル数は起点込みで 8
    expect(path).toHaveLength(8);
    expect(path![0]).toEqual({ x: 0, y: 0 });
    expect(path![path!.length - 1]).toEqual({ x: 3, y: 4 });
  });

  it("detours around an obstacle wall that blocks the direct path", () => {
    // (2,0)-(2,3) を壁にして (0,2) -> (4,2) の直線移動を塞ぐが、(2,4) だけ
    // 開けておき、下へ迂回すれば通れるようにする
    const blocked = new Set(["2,0", "2,1", "2,2", "2,3"]);
    const grid = gridWithWalls(5, 5, blocked);

    const path = findPath(grid, { x: 0, y: 2 }, { x: 4, y: 2 });

    expect(path).not.toBeNull();
    // 直線距離(4 移動)より長い迂回になる
    expect(path!.length).toBeGreaterThan(5);
    // 経路上のどのタイルも壁を通らない
    for (const tile of path!) {
      expect(blocked.has(`${tile.x},${tile.y}`)).toBe(false);
    }
    expect(path![0]).toEqual({ x: 0, y: 2 });
    expect(path![path!.length - 1]).toEqual({ x: 4, y: 2 });
  });

  it("returns null when the destination is fully enclosed by walls (unreachable)", () => {
    // (2,2) を四方 (1,2)(3,2)(2,1)(2,3) の壁で完全に囲む
    const blocked = new Set(["1,2", "3,2", "2,1", "2,3"]);
    const grid = gridWithWalls(5, 5, blocked);

    const path = findPath(grid, { x: 0, y: 0 }, { x: 2, y: 2 });

    expect(path).toBeNull();
  });

  it("returns a single-tile path when the origin equals the destination", () => {
    const grid = openGrid(5, 5);
    const path = findPath(grid, { x: 2, y: 2 }, { x: 2, y: 2 });

    expect(tileKeys(path)).toEqual(["2,2"]);
  });

  it("returns null when the origin tile itself is not walkable", () => {
    const blocked = new Set(["0,0"]);
    const grid = gridWithWalls(5, 5, blocked);

    const path = findPath(grid, { x: 0, y: 0 }, { x: 4, y: 4 });

    expect(path).toBeNull();
  });

  it("returns null when the destination tile itself is not walkable", () => {
    const blocked = new Set(["4,4"]);
    const grid = gridWithWalls(5, 5, blocked);

    const path = findPath(grid, { x: 0, y: 0 }, { x: 4, y: 4 });

    expect(path).toBeNull();
  });

  it("moves only through 4-neighbor steps (no diagonal shortcuts)", () => {
    const grid = openGrid(5, 5);
    const path = findPath(grid, { x: 0, y: 0 }, { x: 2, y: 2 });

    expect(path).not.toBeNull();
    for (let i = 1; i < path!.length; i += 1) {
      const prev = path![i - 1];
      const curr = path![i];
      const manhattanStep = Math.abs(curr.x - prev.x) + Math.abs(curr.y - prev.y);
      expect(manhattanStep).toBe(1);
    }
  });
});
