import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSetup } from "./setup.js";
import { runTeardown } from "./teardown.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const REAL_SETTINGS_RAW = readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf-8");

describe("runTeardown", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-office-teardown-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("AC-3: setup → teardown で JSON として元の fixture と deep equal、残骸なし、バックアップも残らない", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, REAL_SETTINGS_RAW, "utf-8");

    const setupResult = runSetup({ targetPath: target, scope: "user", port: 5000 });
    expect(setupResult.addedSlugs).toHaveLength(8);

    const teardownResult = runTeardown({ targetPath: target });
    expect(teardownResult.ok).toBe(true);
    expect(teardownResult.exitCode).toBe(0);
    expect(teardownResult.removedCount).toBe(8);

    const written = JSON.parse(readFileSync(target, "utf-8"));
    const original = JSON.parse(REAL_SETTINGS_RAW);
    expect(written).toEqual(original);

    // バックアップファイルが一切残っていない
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.includes("ai-office-backup"))).toHaveLength(0);
    expect(entries.filter((e) => e.includes("ai-office-tmp"))).toHaveLength(0);
    expect(entries).toEqual(["settings.json"]);
  });

  it("AC-11: 手書き #ai-office マーカーの8件は teardown 対象外として残る", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, REAL_SETTINGS_RAW, "utf-8");

    const result = runTeardown({ targetPath: target });
    expect(result.removedCount).toBe(0);

    const written = JSON.parse(readFileSync(target, "utf-8"));
    const original = JSON.parse(REAL_SETTINGS_RAW);
    expect(written).toEqual(original);
  });

  it("--keep-backup を指定するとバックアップを保持する", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, REAL_SETTINGS_RAW, "utf-8");
    runSetup({ targetPath: target, scope: "user", port: 5000 });

    const result = runTeardown({ targetPath: target, keepBackup: true });
    expect(result.removedCount).toBe(8);

    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.includes("ai-office-backup")).length).toBeGreaterThan(0);
  });

  it("設定ファイルが存在しない場合は exitCode 0 で何もしない", () => {
    const target = join(dir, "settings.json");
    const result = runTeardown({ targetPath: target });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.removedCount).toBe(0);
  });

  it("壊れた JSON では非0終了・ファイル不変", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, "{ not valid json", "utf-8");
    const before = readFileSync(target, "utf-8");

    const result = runTeardown({ targetPath: target });
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(target, "utf-8")).toBe(before);
  });

  it("除去対象が無い場合は書き込みすらしない", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");
    const before = readFileSync(target, "utf-8");

    const result = runTeardown({ targetPath: target });
    expect(result.removedCount).toBe(0);
    expect(readFileSync(target, "utf-8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  describe("Phase3 finding2: hooks キー削除の3パターン round-trip", () => {
    it("パターンA: hooks キーが元から無い(実物の ~/.claude/settings.json 相当)場合、round-trip で完全に元通りになる", () => {
      const target = join(dir, "settings.json");
      const original = {
        model: "opus[1m]",
        enabledPlugins: { "frontend-design@claude-plugins-official": true },
        effortLevel: "xhigh",
        theme: "dark",
      };
      writeFileSync(target, JSON.stringify(original), "utf-8");

      runSetup({ targetPath: target, scope: "user", port: 4100 });
      const result = runTeardown({ targetPath: target });

      expect(result.removedCount).toBe(8);
      const written = JSON.parse(readFileSync(target, "utf-8"));
      expect(written).toEqual(original);
      expect(Object.prototype.hasOwnProperty.call(written, "hooks")).toBe(false);
    });

    it("パターンB: 元が空の hooks:{} の場合、round-trip 後は hooks キーごと消える(実害なしとして許容)", () => {
      const target = join(dir, "settings.json");
      writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");

      runSetup({ targetPath: target, scope: "user", port: 4100 });
      const result = runTeardown({ targetPath: target });

      expect(result.removedCount).toBe(8);
      const written = JSON.parse(readFileSync(target, "utf-8"));
      expect(written).toEqual({});
    });

    it("パターンC: 他ツールの hooks が同居している場合、round-trip 後もそれらは維持される(hooks キーは残る)", () => {
      const target = join(dir, "settings.json");
      const original = {
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [{ type: "command", command: "other-tool-script.sh" }],
            },
          ],
        },
      };
      writeFileSync(target, JSON.stringify(original), "utf-8");

      runSetup({ targetPath: target, scope: "user", port: 4100 });
      const result = runTeardown({ targetPath: target });

      expect(result.removedCount).toBe(8);
      const written = JSON.parse(readFileSync(target, "utf-8"));
      expect(written).toEqual(original);
    });
  });

  it("Phase3 finding7: --keep-backup で意図的に残した過去のバックアップは、後続の setup/teardown サイクルで削除されない", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");

    // 1周目: --keep-backup なので setup 分・teardown 分の両方のバックアップが残る
    runSetup({ targetPath: target, scope: "user", port: 4100, now: () => new Date("2020-01-01T00:00:00.000Z") });
    runTeardown({ targetPath: target, keepBackup: true, now: () => new Date("2020-01-01T00:01:00.000Z") });

    const keptBackups = readdirSync(dir).filter((e) => e.includes("ai-office-backup")).sort();
    expect(keptBackups.length).toBe(2);

    // 2周目: 通常の setup → teardown（今回分のバックアップは既定で削除される）
    runSetup({ targetPath: target, scope: "user", port: 4100, now: () => new Date("2020-06-01T00:00:00.000Z") });
    runTeardown({ targetPath: target, now: () => new Date("2020-06-01T00:01:00.000Z") });

    const finalEntries = readdirSync(dir);
    // 1周目で意図的に --keep-backup した2件は両方とも生き残っている
    for (const name of keptBackups) {
      expect(finalEntries).toContain(name);
    }
    // 2周目自身が作ったバックアップ(setup分・teardown分)は掃除されている
    const backups = finalEntries.filter((e) => e.includes("ai-office-backup")).sort();
    expect(backups).toEqual(keptBackups);
  });

  it("Phase3 finding8: 設定ファイルパスがディレクトリの場合、未捕捉例外にせず非0終了・ファイル不変で報告する", () => {
    const target = join(dir, "a-directory-not-a-file");
    mkdirSync(target);

    expect(() => runTeardown({ targetPath: target })).not.toThrow();
    const result = runTeardown({ targetPath: target });
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});
