import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `startDir` から上方（親ディレクトリ方向）へ package.json を探索し、いずれかの
 * `name` が `repoName` と一致するかを判定する。**最も近い package.json だけでなく
 * 全ての祖先**を調べる（`--project` をリポジトリのサブパッケージから実行しても、
 * そのサブパッケージ自身の package.json は別名を持つため、ルートまで遡る必要がある。
 * AC-11d）。
 *
 * 壊れた package.json は無視して探索を継続する（誤検知よりも「見逃して --force を
 * 促す」方を安全側とする）。ファイルシステムルートに達したら false を返す。
 */
export function isInsideNamedRepo(startDir: string, repoName: string): boolean {
  let dir = startDir;

  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === repoName
        ) {
          return true;
        }
      } catch {
        // 壊れた package.json は無視して上方探索を続ける
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}
