import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSetup } from "./setup.js";
import { MARKER } from "./hooks-spec.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const REAL_SETTINGS_RAW = readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf-8");

describe("runSetup", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-office-setup-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("AC-1: 本リポジトリの settings.json fixture に既存を壊さず8件追加する", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, REAL_SETTINGS_RAW, "utf-8");

    const result = runSetup({ targetPath: target, scope: "user", port: 5000 });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.addedSlugs).toHaveLength(8);

    const written = JSON.parse(readFileSync(target, "utf-8"));
    const original = JSON.parse(REAL_SETTINGS_RAW);
    // 既存 PostToolUse の非 ai-office エントリが残っている
    const postTool = written.hooks.PostToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const editWrite = postTool.find((g) => g.matcher === "Edit|Write");
    expect(editWrite?.hooks).toHaveLength(2);
    expect(original.permissions).toEqual(written.permissions);
  });

  it("AC-2: 冪等 — 2回目の setup は0件追加、内容が一致", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");

    const first = runSetup({ targetPath: target, scope: "user", port: 4100 });
    expect(first.addedSlugs).toHaveLength(8);
    const afterFirst = readFileSync(target, "utf-8");

    const second = runSetup({ targetPath: target, scope: "user", port: 4100 });
    expect(second.addedSlugs).toHaveLength(0);
    expect(readFileSync(target, "utf-8")).toBe(afterFirst);
  });

  it("AC-4: --dry-run は書き込まない（mtime・バイト列が不変）", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");
    const before = statSync(target);
    const beforeContent = readFileSync(target, "utf-8");

    const result = runSetup({ targetPath: target, scope: "user", port: 4100, dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.addedSlugs).toHaveLength(8); // 計算上は追加対象だが書き込みはしない

    const after = statSync(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(readFileSync(target, "utf-8")).toBe(beforeContent);
  });

  it("AC-5: 壊れた JSON では非0終了・ファイル不変", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, "{ not valid json", "utf-8");
    const before = readFileSync(target, "utf-8");

    const result = runSetup({ targetPath: target, scope: "user", port: 4100 });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(target, "utf-8")).toBe(before);
  });

  it("AC-6: Relay が起動していなくても setup 自体は成功する(ネットワークを一切叩かない)", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");
    const result = runSetup({ targetPath: target, scope: "user", port: 59999 });
    expect(result.exitCode).toBe(0);
  });

  it("生成される全コマンドが NFR-2 準拠（--max-time 2 / || true / マーカー）", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");
    runSetup({ targetPath: target, scope: "user", port: 4100 });

    const written = readFileSync(target, "utf-8");
    const commandLines = [...written.matchAll(/"command":\s*"([^"]*)"/g)]
      .map((m) => m[1])
      .filter((c) => c.includes(MARKER));
    expect(commandLines).toHaveLength(8);
    for (const cmd of commandLines) {
      expect(cmd).toContain("--max-time 2");
      expect(cmd).toContain("|| true");
      expect(cmd).toContain(MARKER);
    }
  });

  it("新規ディレクトリ（.claude が存在しない）でも作成して書き込む", () => {
    const target = join(dir, "nested", ".claude", "settings.json");
    const result = runSetup({ targetPath: target, scope: "user", port: 4100 });
    expect(result.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("AC-11d: リポジトリガード — --project でリポジトリのサブディレクトリから実行すると中断", () => {
    const nestedCwd = join(REPO_ROOT, "packages", "relay");
    const target = join(dir, "settings.json"); // 実際にはガードで中断するため書き込まれない
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");
    const before = readFileSync(target, "utf-8");

    const result = runSetup({
      targetPath: target,
      scope: "project",
      port: 4100,
      repoGuardCwd: nestedCwd,
      repoGuardName: "ai-virtual-office",
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(target, "utf-8")).toBe(before);
  });

  it("リポジトリガードは --force で上書きできる", () => {
    const nestedCwd = join(REPO_ROOT, "packages", "relay");
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");

    const result = runSetup({
      targetPath: target,
      scope: "project",
      port: 4100,
      repoGuardCwd: nestedCwd,
      repoGuardName: "ai-virtual-office",
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(result.addedSlugs).toHaveLength(8);
  });

  it("scope: user のときはリポジトリガードを適用しない", () => {
    const nestedCwd = join(REPO_ROOT, "packages", "relay");
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");

    const result = runSetup({
      targetPath: target,
      scope: "user",
      port: 4100,
      repoGuardCwd: nestedCwd,
      repoGuardName: "ai-virtual-office",
    });

    expect(result.ok).toBe(true);
  });

  it("AC-12 TOCTOU 経路: 書き込み直前の衝突は非0終了・ファイル不変で報告する", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");

    // runSetup 内部の loadSettings 完了後に外部から書き換わるケースを模すため、
    // 一連の flow を直接検証するのは fs-safety.test.ts が担う。ここでは setup が
    // fs-safety のエラーを非0終了として正しく伝播することのみを確認する。
    // (実際の TOCTOU 競合を起こすのが難しいため、書き込み不能ディレクトリで代用)
    mkdirSync(join(dir, "readonly-child"));
    const roTarget = join(dir, "readonly-child", "settings.json");
    writeFileSync(roTarget, JSON.stringify({ hooks: {} }), "utf-8");
    const before = readFileSync(roTarget, "utf-8");

    chmodSync(join(dir, "readonly-child"), 0o555);
    try {
      const result = runSetup({ targetPath: roTarget, scope: "user", port: 4100 });
      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
    } finally {
      chmodSync(join(dir, "readonly-child"), 0o755);
    }
    expect(readFileSync(roTarget, "utf-8")).toBe(before);
  });

  it("何も追加しない場合(全て冪等)はファイルへ書き込みすらしない(バックアップも作らない)", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");
    runSetup({ targetPath: target, scope: "user", port: 4100 });

    const before = statSync(target);
    const beforeEntries = readdirSync(dir);

    const second = runSetup({ targetPath: target, scope: "user", port: 4100 });
    expect(second.addedSlugs).toHaveLength(0);

    const after = statSync(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(dir)).toEqual(beforeEntries);
  });

  it("Phase3 finding1: 壊れた形状(非配列)の既存イベントは無警告で上書きせず、警告付きで報告する", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: { PostToolUse: "my-precious-guard.sh" } }), "utf-8");

    const result = runSetup({ targetPath: target, scope: "user", port: 4100 });

    expect(result.ok).toBe(true);
    expect(result.skippedMalformedSlugs).toContain("post-tool");
    expect(result.addedSlugs).not.toContain("post-tool");
    expect(result.message).toContain("post-tool");

    const written = JSON.parse(readFileSync(target, "utf-8"));
    // 既存の壊れた値がそのまま保存されている(無警告での上書き削除が起きない)
    expect(written.hooks.PostToolUse).toBe("my-precious-guard.sh");
  });

  it("Phase3 finding3: 本リポジトリ形状(手書き #ai-office・同一ポート)へ setup すると全8件が二重送信されない", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, REAL_SETTINGS_RAW, "utf-8");

    // 実 fixture の手書き curl はポート4100を叩く。同一ポートで実行する。
    const result = runSetup({ targetPath: target, scope: "user", port: 4100 });

    expect(result.addedSlugs).toHaveLength(0);
    expect(result.skippedDuplicateSlugs).toHaveLength(8);

    const written = readFileSync(target, "utf-8");
    expect(written.split(MARKER).length - 1).toBe(0);
  });
});
