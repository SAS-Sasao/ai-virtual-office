// AC-2 実測: 実リポジトリ（/home/toyoki05/cc-sier-organization）に対して import を実行し、
// 3 部署の間取りが生成されることを確認する。
//
// 設計メモ「テスト方針」: 実リポジトリ依存のテストは実在チェック付きで最小限にとどめる
// （CI 移植性のため、通常のロジック検証は fixture ベースの他テストファイルを正とする）。
// このリポジトリが存在しない環境（実機以外の CI 等）では describe.skip にフォールバックする
// ——これは「テスト弱体化」ではなく、外部リポジトリという環境依存リソースの有無を機械的に
// 判定しているだけであり、fixture 側のテスト（parse-masters.test.ts / import-org.test.ts /
// cli.test.ts）がロジックの正当性を別途保証している（tests.md ルール 1 の「理由の明示」）。
//
// 出力は必ず一時ディレクトリへ（--out）書く。実リポジトリは読み取り専用で扱い、
// `~/.ai-office/` は一切書き込まない。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Floor } from "@ai-office/protocol";
import { defaultFsDeps } from "./fs-io.js";
import { runImport, type CliDeps } from "./cli.js";
import { checkFloorConnectivity } from "./import-org.js";

const REAL_REPO = "/home/toyoki05/cc-sier-organization";
const hasRealRepo = existsSync(join(REAL_REPO, ".companies"));

const workDirs: string[] = [];
afterEach(() => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDeps(): CliDeps & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    fs: defaultFsDeps,
    homedir: () => join(tmpdir(), "ai-office-adapter-ac2-should-not-be-used"),
    env: {},
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    logs,
    errors,
  };
}

(hasRealRepo ? describe : describe.skip)("AC-2: import against the real cc-sier-organization checkout", () => {
  it("produces 3/6/2 departments across the 3 real organizations, with 3 active rooms + 3 characters for domain-tech-collection", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ai-office-adapter-ac2-out-"));
    workDirs.push(outDir);
    const deps = makeDeps();

    const result = runImport({ repo: REAL_REPO, out: outDir, dryRun: false, help: false }, deps);
    expect(result.exitCode).toBe(0);

    const layout = JSON.parse(readFileSync(join(outDir, "office-layout.json"), "utf-8"));
    const characters = JSON.parse(readFileSync(join(outDir, "characters.json"), "utf-8"));
    const attribution = JSON.parse(readFileSync(join(outDir, "attribution.json"), "utf-8"));

    // 3 組織すべてが floors に含まれる
    const orgIds = layout.floors.map((f: { org: string }) => f.org).sort();
    expect(orgIds).toEqual(["domain-tech-collection", "jutaku-dev-team", "standardization-initiative"]);

    // 部署数（active + standby 合計）: 3 / 6 / 2
    const roomCountByOrg = Object.fromEntries(
      layout.floors.map((f: { org: string; rooms: unknown[] }) => [f.org, f.rooms.length]),
    );
    expect(roomCountByOrg).toEqual({
      "domain-tech-collection": 3,
      "jutaku-dev-team": 6,
      "standardization-initiative": 2,
    });

    // domain-tech-collection: active room 3 件・character 3 ロール
    const domainTechFloor = layout.floors.find((f: { org: string }) => f.org === "domain-tech-collection");
    const activeRooms = domainTechFloor.rooms.filter((r: { status: string }) => r.status === "active");
    expect(activeRooms).toHaveLength(3);

    const domainTechCharacters = characters.filter((c: { org: string }) => c.org === "domain-tech-collection");
    expect(domainTechCharacters).toHaveLength(3);

    // characters.json 全体は 3 組織のロール数の合計（3 + 13 + 2）
    expect(characters).toHaveLength(18);

    // 帰属インデックス: .active（domain-tech-collection）を指す repoPrefix が 1 件
    expect(attribution.repoPrefixes).toEqual([{ prefix: REAL_REPO, org: "domain-tech-collection" }]);
    expect(attribution.branchOrgs.sort()).toEqual([
      "domain-tech-collection",
      "jutaku-dev-team",
      "standardization-initiative",
    ]);

    // M1-4a rev.2 F1（AC-3b②の実リポジトリ版）: 実 3 組織すべてで、入口（フロア最下段
    // 中央）から全 active 部屋の door を経て内部へ到達できる（生成時に adapter 自身が
    // 保証している不変条件を、実リポジトリの生成物に対しても再確認する）。
    for (const floor of layout.floors as Floor[]) {
      const connectivity = checkFloorConnectivity(floor);
      expect(connectivity, `org "${floor.org}" should have full connectivity`).toEqual({
        ok: true,
        unreachableRoomIds: [],
      });
    }

    // 受付（dept-secretary）はもう全幅ではない（rev.2: 他部屋と同じロール数比例幅・
    // 最下段中央寄せ）。
    for (const floor of layout.floors as Floor[]) {
      const reception = floor.rooms.find((r: { id: string }) => r.id === "dept-secretary");
      expect(reception).toBeDefined();
      expect(reception!.w).toBeLessThan(floor.grid.cols);
    }
  });

  it("is idempotent against the real repo: re-running produces byte-identical output", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ai-office-adapter-ac2-out-"));
    workDirs.push(outDir);
    const deps = makeDeps();

    runImport({ repo: REAL_REPO, out: outDir, dryRun: false, help: false }, deps);
    const layoutBytes1 = readFileSync(join(outDir, "office-layout.json"), "utf-8");

    runImport({ repo: REAL_REPO, out: outDir, dryRun: false, help: false }, deps);
    const layoutBytes2 = readFileSync(join(outDir, "office-layout.json"), "utf-8");

    expect(layoutBytes2).toBe(layoutBytes1);
  });
});
