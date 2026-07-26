import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// Next.js は `next dev`/`next build` の起動時に tsconfig.json と next-env.d.ts を
// distDir（ここでは .next-e2e）へ自動追随させて書き換える。E2E の webServer が
// これらをdogfooding（.next）向けの内容から書き換えたまま残すと作業ツリーが
// 汚れてしまう（verify.sh が `next build` に対して backup/restore で解決したのと
// 同じ事象・ギャップ記録 3）。config 読込時にスナップショットを取り、Playwright の
// globalTeardown で確実に復元する。
//
// スナップショットは各ファイルの隣に `<name>.e2ebak` として置く（.gitignore 済み）。
// config は main / worker の複数プロセスで読み込まれるため、pristine を上書き
// しないよう「bak が無いときだけ」取得する。teardown は 1 度だけ走り、復元して
// bak を消す。プロセスがクラッシュして bak が残っても、次回は pristine な bak が
// 保持され teardown で復元されるため自己修復する。

const WEB_DIR = __dirname;

/** Next.js が起動時に書き換える恐れのある管理ファイル群（絶対パス）。 */
export const NEXT_MANAGED_FILES: readonly string[] = [
  join(WEB_DIR, "tsconfig.json"),
  join(WEB_DIR, "next-env.d.ts"),
];

function bakPath(file: string): string {
  return `${file}.e2ebak`;
}

/** config 読込時に呼ぶ: pristine 版のスナップショットを取る（既存の bak は温存）。 */
export function snapshotNextManagedFiles(): void {
  for (const file of NEXT_MANAGED_FILES) {
    const bak = bakPath(file);
    if (existsSync(file) && !existsSync(bak)) {
      copyFileSync(file, bak);
    }
  }
}

/** globalTeardown: スナップショットから復元し、bak を削除する。 */
export default function globalTeardown(): void {
  for (const file of NEXT_MANAGED_FILES) {
    const bak = bakPath(file);
    if (existsSync(bak)) {
      copyFileSync(bak, file);
      rmSync(bak, { force: true });
    }
  }
}
