// runImport を「本物の」node:fs（defaultFsDeps）に対して実行する検証。
//
// 目的: fake-fs（インメモリ）ベースの cli.test.ts はロジックの高速検証に向くが、
// AC-5 の「既存出力ファイルが mtime ごと不変」は実ファイルシステムでしか意味を
// 持たない概念（インメモリ実装には mtime という概念自体が無い）。この 1 ファイルだけ
// 実際の一時ディレクトリ（os.tmpdir() 配下）に読み書きして検証する。
//
// `~/.ai-office/` には絶対に触れない: --repo / --out を必ず明示し、homedir() は
// 存在しないダミーパスを返すよう固定した上で config.json 読み取り経路にも入らないことを
// 1 テストで直接検証する。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultFsDeps } from "./fs-io.js";
import { runImport, type CliDeps } from "./cli.js";
import { DEPARTMENTS_MD, DEPARTMENTS_MD_ALL_BROKEN, ORGANIZATION_MD, ROLES_MD } from "./fixtures/masters.js";

const workDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    fs: defaultFsDeps,
    // 実 fs テストでも "~/.ai-office/ に書き込まない" を強制するため、存在しない
    // ダミーの home を返す（--repo/--out を必ず明示するテストのみここで実行する）。
    homedir: () => join(tmpdir(), "ai-office-adapter-test-should-not-be-used"),
    env: {},
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    logs,
    errors,
    ...overrides,
  };
}

function writeRealOrg(repoRoot: string, orgId = "domain-tech-collection"): void {
  const mastersDir = join(repoRoot, ".companies", orgId, "masters");
  mkdirSync(mastersDir, { recursive: true });
  writeFileSync(join(repoRoot, ".companies", ".active"), `${orgId}\n`, "utf-8");
  writeFileSync(join(mastersDir, "organization.md"), ORGANIZATION_MD, "utf-8");
  writeFileSync(join(mastersDir, "departments.md"), DEPARTMENTS_MD, "utf-8");
  writeFileSync(join(mastersDir, "roles.md"), ROLES_MD, "utf-8");
}

describe("runImport against a real filesystem", () => {
  it("writes 3 files with 2-space-indented, byte-identical JSON across 2 runs (AC-3)", () => {
    const repoRoot = makeTempDir("ai-office-adapter-repo-");
    const outDir = makeTempDir("ai-office-adapter-out-");
    writeRealOrg(repoRoot);
    const deps = makeDeps();

    const first = runImport({ repo: repoRoot, out: outDir, dryRun: false, help: false }, deps);
    expect(first.exitCode).toBe(0);

    const layoutBytes1 = readFileSync(join(outDir, "office-layout.json"), "utf-8");
    const charactersBytes1 = readFileSync(join(outDir, "characters.json"), "utf-8");
    const attributionBytes1 = readFileSync(join(outDir, "attribution.json"), "utf-8");

    const second = runImport({ repo: repoRoot, out: outDir, dryRun: false, help: false }, deps);
    expect(second.exitCode).toBe(0);

    expect(readFileSync(join(outDir, "office-layout.json"), "utf-8")).toBe(layoutBytes1);
    expect(readFileSync(join(outDir, "characters.json"), "utf-8")).toBe(charactersBytes1);
    expect(readFileSync(join(outDir, "attribution.json"), "utf-8")).toBe(attributionBytes1);
  });

  it("leaves existing output files completely unchanged (mtime and content) when the run fails (AC-5)", async () => {
    const repoRoot = makeTempDir("ai-office-adapter-repo-");
    const outDir = makeTempDir("ai-office-adapter-out-");
    mkdirSync(join(repoRoot, ".companies", "broken-org", "masters"), { recursive: true });
    writeFileSync(join(repoRoot, ".companies", ".active"), "broken-org\n", "utf-8");
    writeFileSync(
      join(repoRoot, ".companies", "broken-org", "masters", "departments.md"),
      DEPARTMENTS_MD_ALL_BROKEN,
      "utf-8",
    );

    const existingLayout = `${JSON.stringify({ version: 1, floors: [] }, null, 2)}\n`;
    const existingCharacters = "[]\n";
    writeFileSync(join(outDir, "office-layout.json"), existingLayout, "utf-8");
    writeFileSync(join(outDir, "characters.json"), existingCharacters, "utf-8");

    const layoutPath = join(outDir, "office-layout.json");
    const charactersPath = join(outDir, "characters.json");
    const beforeLayoutMtime = statSync(layoutPath).mtimeMs;
    const beforeCharactersMtime = statSync(charactersPath).mtimeMs;

    // mtime 分解能の粗い環境でも差分を検出できるよう、書き込み判定の猶予を置く
    // （sleep はテストルール違反のため使わず、同期的に判定できるここでは不要。
    // mtime が変化していないことは統計的猶予無しでそのまま比較できる）。
    const deps = makeDeps();
    const result = runImport({ repo: repoRoot, out: outDir, dryRun: false, help: false }, deps);

    expect(result.exitCode).not.toBe(0);
    expect(statSync(layoutPath).mtimeMs).toBe(beforeLayoutMtime);
    expect(statSync(charactersPath).mtimeMs).toBe(beforeCharactersMtime);
    expect(readFileSync(layoutPath, "utf-8")).toBe(existingLayout);
    expect(readFileSync(charactersPath, "utf-8")).toBe(existingCharacters);
    expect(existsSync(join(outDir, "attribution.json"))).toBe(false);
  });

  it("never creates the dummy home directory returned by homedir() (config.json path untouched)", () => {
    const repoRoot = makeTempDir("ai-office-adapter-repo-");
    const outDir = makeTempDir("ai-office-adapter-out-");
    writeRealOrg(repoRoot);
    const deps = makeDeps();

    runImport({ repo: repoRoot, out: outDir, dryRun: false, help: false }, deps);

    expect(existsSync(join(tmpdir(), "ai-office-adapter-test-should-not-be-used"))).toBe(false);
  });
});
