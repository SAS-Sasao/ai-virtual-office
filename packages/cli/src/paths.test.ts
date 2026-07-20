import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolvePaths } from "./paths.js";

describe("resolvePaths", () => {
  it("既定値は home / cwd から .claude/settings*.json を組み立てる", () => {
    const paths = resolvePaths({
      home: "/home/fixture-user",
      cwd: "/work/fixture-project",
      env: {},
    });

    expect(paths).toEqual({
      userSettingsPath: join("/home/fixture-user", ".claude", "settings.json"),
      projectSettingsPath: join("/work/fixture-project", ".claude", "settings.json"),
      userLocalSettingsPath: join("/home/fixture-user", ".claude", "settings.local.json"),
      projectLocalSettingsPath: join("/work/fixture-project", ".claude", "settings.local.json"),
    });
  });

  // AC: doctor が参照する 4 パスすべてが env で差し替え可能であることの機械保証。
  // 実行環境の実ファイル（$HOME/.claude/settings.json 等）を一切読まないことを
  // このテストで担保する。
  it("4 パスすべてが専用の env 変数で個別に差し替え可能", () => {
    const paths = resolvePaths({
      home: "/home/fixture-user",
      cwd: "/work/fixture-project",
      env: {
        AI_OFFICE_USER_SETTINGS_PATH: "/override/user-settings.json",
        AI_OFFICE_PROJECT_SETTINGS_PATH: "/override/project-settings.json",
        AI_OFFICE_USER_LOCAL_SETTINGS_PATH: "/override/user-local.json",
        AI_OFFICE_PROJECT_LOCAL_SETTINGS_PATH: "/override/project-local.json",
      } as NodeJS.ProcessEnv,
    });

    expect(paths).toEqual({
      userSettingsPath: "/override/user-settings.json",
      projectSettingsPath: "/override/project-settings.json",
      userLocalSettingsPath: "/override/user-local.json",
      projectLocalSettingsPath: "/override/project-local.json",
    });
  });

  it("env は個別に一部だけ差し替えても残りは既定値のまま", () => {
    const paths = resolvePaths({
      home: "/home/fixture-user",
      cwd: "/work/fixture-project",
      env: { AI_OFFICE_USER_SETTINGS_PATH: "/override/user-settings.json" } as NodeJS.ProcessEnv,
    });

    expect(paths.userSettingsPath).toBe("/override/user-settings.json");
    expect(paths.projectSettingsPath).toBe(join("/work/fixture-project", ".claude", "settings.json"));
    expect(paths.userLocalSettingsPath).toBe(join("/home/fixture-user", ".claude", "settings.local.json"));
    expect(paths.projectLocalSettingsPath).toBe(
      join("/work/fixture-project", ".claude", "settings.local.json"),
    );
  });

  it("options を省略すると実際の os.homedir()/process.cwd()/process.env を使う（呼び出し可能であることのみ確認）", () => {
    const paths = resolvePaths();
    expect(typeof paths.userSettingsPath).toBe("string");
    expect(typeof paths.projectSettingsPath).toBe("string");
    expect(typeof paths.userLocalSettingsPath).toBe("string");
    expect(typeof paths.projectLocalSettingsPath).toBe("string");
  });
});
