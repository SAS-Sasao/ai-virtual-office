// タイルグリッド上の BFS 経路探索（M1-4a）。純関数・4 近傍のみ。
// game 層の他モジュール（layout-runtime / scene）と同様、時刻・乱数を持たない
// 決定論的な実装であること。

export interface Tile {
  x: number;
  y: number;
}

/**
 * 歩行可否を問い合わせるための最小インターフェース。実体は
 * layout-runtime.ts の `buildWalkGrid` が OfficeLayout の Room/door から
 * 構築する（door の位置を推測せず、スキーマの値をそのまま使う契約は
 * layout-runtime.ts 側の責務）。
 */
export interface WalkGrid {
  readonly cols: number;
  readonly rows: number;
  isWalkable(x: number, y: number): boolean;
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

/**
 * `from` から `to` までの最短経路を 4 近傍 BFS で求める。
 *
 * - 戻り値は `from` を含み `to` を含む、隣接タイルの列（各ステップはマンハッタン
 *   距離 1）。`from` と `to` が同一タイルの場合は単一要素の配列を返す
 * - `from` / `to` のいずれかが歩行不可、または到達不能な場合は `null` を返す。
 *   呼び出し側（scene.ts）はこれを「その場に留まる」の合図として扱い、
 *   テレポートしない
 */
export function findPath(grid: WalkGrid, from: Tile, to: Tile): Tile[] | null {
  if (!grid.isWalkable(from.x, from.y) || !grid.isWalkable(to.x, to.y)) {
    return null;
  }

  const startKey = tileKey(from.x, from.y);
  const visited = new Set<string>([startKey]);
  const cameFrom = new Map<string, Tile>();
  const queue: Tile[] = [from];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;

    if (current.x === to.x && current.y === to.y) {
      const path: Tile[] = [current];
      let key = tileKey(current.x, current.y);
      let parent = cameFrom.get(key);
      while (parent) {
        path.push(parent);
        key = tileKey(parent.x, parent.y);
        parent = cameFrom.get(key);
      }
      path.reverse();
      return path;
    }

    for (const [dx, dy] of NEIGHBOR_DELTAS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const key = tileKey(nx, ny);
      if (visited.has(key)) continue;
      if (!grid.isWalkable(nx, ny)) continue;
      visited.add(key);
      cameFrom.set(key, current);
      queue.push({ x: nx, y: ny });
    }
  }

  return null;
}
