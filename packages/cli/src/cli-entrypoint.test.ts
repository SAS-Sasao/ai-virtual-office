import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_TEXT } from "./index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const DIST_INDEX = join(PACKAGE_ROOT, "dist", "index.js");

/**
 * Phase3 レビュー finding5: `npx ai-office` / `node_modules/.bin/ai-office` は
 * シンボリックリンク経由で dist/index.js を起動する。`isMainModule` の判定を
 * 誤ると、ヘルプすら表示せず**exit 0 のまま無言終了する**というサイレントな
 * 退行が起こり得る（exit code だけを見るテストでは検出できない）。そのため
 * ここでは実際に子プロセスとしてシンボリックリンク経由で起動し、exit code
 * だけでなく stdout の内容も検証する。
 */
describe("CLI entrypoint（.bin シンボリックリンク経由の起動、実子プロセス）", () => {
  beforeAll(() => {
    // このテストは常に最新の src を反映した dist を要求する（stale な dist を
    // 誤って green と報告しないよう、毎回ビルドし直す）。
    const tsc = join(PACKAGE_ROOT, "node_modules", ".bin", "tsc");
    execFileSync(tsc, [], { cwd: PACKAGE_ROOT });
    chmodSync(DIST_INDEX, 0o755);
  }, 60_000);

  it("シンボリックリンク経由で --help を実行すると exit 0 かつヘルプ本文が出力される", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-bin-symlink-"));
    try {
      const linkPath = join(dir, "ai-office");
      symlinkSync(DIST_INDEX, linkPath);

      const stdout = execFileSync(process.execPath, [linkPath, "--help"], { encoding: "utf-8" });

      // 退行時（旧 isMainModule 判定）は stdout が空文字列のまま exit 0 になる。
      // exit code だけでなく本文の中身を assert しなければこのバグは検出できない。
      expect(stdout).toContain("ai-office");
      expect(stdout).toBe(`${HELP_TEXT}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("シンボリックリンク経由で直接実行しても exit 0 かつヘルプ本文が出力される(引数無し)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-bin-symlink-noargs-"));
    try {
      const linkPath = join(dir, "ai-office");
      symlinkSync(DIST_INDEX, linkPath);

      const stdout = execFileSync(process.execPath, [linkPath], { encoding: "utf-8" });
      expect(stdout.length).toBeGreaterThan(0);
      expect(stdout).toContain("ai-office");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("シンボリックリンクを介さず直接実行しても同じ結果になる(回帰の比較対象)", () => {
    const stdout = execFileSync(process.execPath, [DIST_INDEX, "--help"], { encoding: "utf-8" });
    expect(stdout).toBe(`${HELP_TEXT}\n`);
  });
});
