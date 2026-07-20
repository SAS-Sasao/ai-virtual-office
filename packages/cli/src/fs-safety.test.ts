import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsParseError,
  SettingsReadError,
  SettingsWriteError,
  ToctouError,
  loadSettings,
  writeSettingsSafely,
} from "./fs-safety.js";

describe("fs-safety", () => {
  let dir: string;

  beforeEach(() => {
    // AC-9 二重防御: settings.json 操作系のテストは必ず mkdtemp の一時ディレクトリで完結させる
    dir = mkdtempSync(join(tmpdir(), "ai-office-fs-safety-"));
  });

  afterEach(() => {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* best-effort */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  describe("loadSettings", () => {
    it("ファイルが存在しない場合 exists:false / baseline:null を返す", () => {
      const target = join(dir, "settings.json");
      const loaded = loadSettings(target);
      expect(loaded.exists).toBe(false);
      expect(loaded.parsed).toBeUndefined();
      expect(loaded.baseline).toBeNull();
      expect(loaded.realPath).toBe(target);
    });

    it("正常な JSON を読み込み、mtime/size のベースラインを記録する", () => {
      const target = join(dir, "settings.json");
      writeFileSync(target, JSON.stringify({ hooks: {} }), "utf-8");

      const loaded = loadSettings(target);
      expect(loaded.exists).toBe(true);
      expect(loaded.parsed).toEqual({ hooks: {} });
      expect(loaded.baseline).not.toBeNull();
      expect(loaded.baseline?.size).toBeGreaterThan(0);
    });

    it("AC-5: 壊れた JSON は SettingsParseError を投げる", () => {
      const target = join(dir, "settings.json");
      writeFileSync(target, "{ not valid json", "utf-8");

      expect(() => loadSettings(target)).toThrow(SettingsParseError);
    });

    it("Phase3 finding8: 読み取り自体が失敗する場合(例: EISDIR)は未捕捉例外ではなく SettingsReadError を投げる", () => {
      const target = join(dir, "a-directory-not-a-file");
      mkdirSync(target);

      expect(() => loadSettings(target)).toThrow(SettingsReadError);
      expect(() => loadSettings(target)).not.toThrow(SettingsParseError);
    });

    it("symlink はターゲットの実体パスを realPath として返す", () => {
      const real = join(dir, "real-settings.json");
      writeFileSync(real, JSON.stringify({ hooks: {} }), "utf-8");
      const link = join(dir, "settings.json");
      symlinkSync(real, link);

      const loaded = loadSettings(link);
      expect(loaded.realPath).toBe(real);
      expect(loaded.exists).toBe(true);
    });
  });

  describe("writeSettingsSafely", () => {
    it("新規作成: ファイルが無い場合はディレクトリごと作成して書き込む", () => {
      const target = join(dir, "nested", ".claude", "settings.json");
      const loaded = loadSettings(target);
      expect(loaded.exists).toBe(false);

      const result = writeSettingsSafely(target, loaded.realPath, loaded.baseline, JSON.stringify({ hooks: {} }));

      expect(result.backupPath).toBeNull();
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ hooks: {} });
    });

    it("既存ファイルの更新: バックアップを作成し、アトミックに置換する", () => {
      const target = join(dir, "settings.json");
      writeFileSync(target, JSON.stringify({ hooks: { a: 1 } }), "utf-8");
      const loaded = loadSettings(target);

      const result = writeSettingsSafely(
        target,
        loaded.realPath,
        loaded.baseline,
        JSON.stringify({ hooks: { a: 1, b: 2 } }),
      );

      expect(result.backupPath).not.toBeNull();
      expect(readFileSync(result.backupPath as string, "utf-8")).toBe(JSON.stringify({ hooks: { a: 1 } }));
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ hooks: { a: 1, b: 2 } });
    });

    it("AC-12 TOCTOU: 読み取り後にファイルが変更されていたら ToctouError を投げ、本体を書き換えない", () => {
      const target = join(dir, "settings.json");
      writeFileSync(target, JSON.stringify({ hooks: { a: 1 } }), "utf-8");
      const loaded = loadSettings(target);

      // 読み取り後、書き込み前に外部から変更される(mtime を明示的に未来へずらす)
      const future = new Date(Date.now() + 60_000);
      writeFileSync(target, JSON.stringify({ hooks: { a: 1, race: true } }), "utf-8");
      utimesSync(target, future, future);

      expect(() =>
        writeSettingsSafely(target, loaded.realPath, loaded.baseline, JSON.stringify({ hooks: { a: 1, b: 2 } })),
      ).toThrow(ToctouError);

      // 本体は「外部からの変更」のまま。CLI の新内容では上書きされていない
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ hooks: { a: 1, race: true } });
    });

    it("AC-12 symlink: 書き込み後もシンボリックリンクは実体ファイルに置換されない", () => {
      const real = join(dir, "real-settings.json");
      writeFileSync(real, JSON.stringify({ hooks: { a: 1 } }), "utf-8");
      const link = join(dir, "settings.json");
      symlinkSync(real, link);

      const loaded = loadSettings(link);
      writeSettingsSafely(link, loaded.realPath, loaded.baseline, JSON.stringify({ hooks: { a: 1, b: 2 } }));

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(link, "utf-8"))).toEqual({ hooks: { a: 1, b: 2 } });
      expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({ hooks: { a: 1, b: 2 } });
    });

    it("AC-12 EACCES: 書き込み不能なディレクトリでは本体を書き換えず SettingsWriteError を投げる", () => {
      const target = join(dir, "settings.json");
      writeFileSync(target, JSON.stringify({ hooks: { a: 1 } }), "utf-8");
      const loaded = loadSettings(target);
      const originalContent = readFileSync(target, "utf-8");

      chmodSync(dir, 0o555); // ディレクトリを読み取り専用に(非 root ユーザ前提)

      try {
        expect(() =>
          writeSettingsSafely(target, loaded.realPath, loaded.baseline, JSON.stringify({ hooks: { a: 1, b: 2 } })),
        ).toThrow(SettingsWriteError);
      } finally {
        chmodSync(dir, 0o755);
      }

      expect(readFileSync(target, "utf-8")).toBe(originalContent);
    });

    it("バックアップ失敗時は一時ファイル等の残骸を残さない(best-effort cleanup)", () => {
      const target = join(dir, "settings.json");
      writeFileSync(target, JSON.stringify({ hooks: { a: 1 } }), "utf-8");
      const loaded = loadSettings(target);

      chmodSync(dir, 0o555);
      try {
        expect(() =>
          writeSettingsSafely(target, loaded.realPath, loaded.baseline, JSON.stringify({ hooks: { a: 1, b: 2 } })),
        ).toThrow();
      } finally {
        chmodSync(dir, 0o755);
      }

      const entries = readdirSync(dir);
      expect(entries.filter((e) => e.includes("ai-office-tmp"))).toHaveLength(0);
      expect(entries.filter((e) => e.includes("ai-office-backup"))).toHaveLength(0);
    });
  });
});
