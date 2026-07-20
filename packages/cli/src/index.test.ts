import { describe, expect, it, vi } from "vitest";
import { runCli, parseFlags, HELP_TEXT, type CliDeps } from "./index.js";
import type { ResolvedPaths } from "./paths.js";

const PATHS: ResolvedPaths = {
  userSettingsPath: "/fixture/user-settings.json",
  projectSettingsPath: "/fixture/project-settings.json",
  userLocalSettingsPath: "/fixture/user-settings.local.json",
  projectLocalSettingsPath: "/fixture/project-settings.local.json",
};

function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    resolvePaths: vi.fn(() => PATHS),
    runSetup: vi.fn(() => ({
      ok: true,
      exitCode: 0,
      addedSlugs: ["session-start"],
      skippedIdempotentSlugs: [],
      skippedDuplicateSlugs: [],
      skippedMalformedSlugs: [],
      backupPath: null,
      dryRun: false,
      message: "added 1 hooks",
    })),
    runTeardown: vi.fn(() => ({
      ok: true,
      exitCode: 0,
      removedCount: 0,
      message: "nothing to remove",
    })),
    runDoctor: vi.fn(async () => ({
      hooks: [],
      relay: { reachable: true, health: undefined },
      hooksInstalled: true,
      eventReachedWarning: false,
      fatalReasons: [],
      exitCode: 0 as const,
    })),
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe("parseFlags", () => {
  it("既知のフラグを解析する", () => {
    const flags = parseFlags(["setup", "--dry-run", "--project", "--port", "5000", "--force", "--keep-backup"]);
    expect(flags).toMatchObject({
      dryRun: true,
      project: true,
      force: true,
      keepBackup: true,
      port: 5000,
    });
  });

  it("--help / -h を検出する", () => {
    expect(parseFlags(["--help"]).help).toBe(true);
    expect(parseFlags(["-h"]).help).toBe(true);
    expect(parseFlags(["setup"]).help).toBe(false);
  });

  it("フラグが無い場合は既定値", () => {
    const flags = parseFlags(["doctor"]);
    expect(flags.dryRun).toBe(false);
    expect(flags.project).toBe(false);
    expect(flags.force).toBe(false);
    expect(flags.keepBackup).toBe(false);
    expect(flags.port).toBeUndefined();
  });
});

describe("runCli", () => {
  it("引数無し、または --help は HELP_TEXT を表示して exit 0", async () => {
    const deps = makeDeps();
    const code1 = await runCli([], deps);
    const code2 = await runCli(["--help"], deps);
    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(deps.log).toHaveBeenCalledWith(HELP_TEXT);
  });

  it("setup（既定 = user スコープ）を実行する", async () => {
    const deps = makeDeps();
    const code = await runCli(["setup"], deps);
    expect(code).toBe(0);
    expect(deps.runSetup).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: PATHS.userSettingsPath, scope: "user", port: 4100 }),
    );
  });

  it("setup --project は project スコープを使う", async () => {
    const deps = makeDeps();
    await runCli(["setup", "--project"], deps);
    expect(deps.runSetup).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: PATHS.projectSettingsPath, scope: "project" }),
    );
  });

  it("setup --port を反映する", async () => {
    const deps = makeDeps();
    await runCli(["setup", "--port", "5000"], deps);
    expect(deps.runSetup).toHaveBeenCalledWith(expect.objectContaining({ port: 5000 }));
  });

  it("setup が失敗したら exitCode を伝播する", async () => {
    const deps = makeDeps({
      runSetup: vi.fn(() => ({
        ok: false,
        exitCode: 1,
        addedSlugs: [],
        skippedIdempotentSlugs: [],
        skippedDuplicateSlugs: [],
        skippedMalformedSlugs: [],
        backupPath: null,
        dryRun: false,
        message: "error",
      })),
    });
    const code = await runCli(["setup"], deps);
    expect(code).toBe(1);
  });

  it("teardown を実行する", async () => {
    const deps = makeDeps();
    const code = await runCli(["teardown"], deps);
    expect(code).toBe(0);
    expect(deps.runTeardown).toHaveBeenCalledWith(expect.objectContaining({ targetPath: PATHS.userSettingsPath }));
  });

  it("teardown --keep-backup を反映する", async () => {
    const deps = makeDeps();
    await runCli(["teardown", "--keep-backup"], deps);
    expect(deps.runTeardown).toHaveBeenCalledWith(expect.objectContaining({ keepBackup: true }));
  });

  it("doctor を実行し exitCode を伝播する", async () => {
    const deps = makeDeps({
      runDoctor: vi.fn(async () => ({
        hooks: [],
        relay: { reachable: false, error: "ECONNREFUSED" },
        hooksInstalled: false,
        eventReachedWarning: false,
        fatalReasons: ["hooks-not-installed", "relay-unreachable"],
        exitCode: 1 as const,
      })),
    });
    const code = await runCli(["doctor"], deps);
    expect(code).toBe(1);
    expect(deps.runDoctor).toHaveBeenCalled();
  });

  it("未知のコマンドは非0終了", async () => {
    const deps = makeDeps();
    const code = await runCli(["frobnicate"], deps);
    expect(code).not.toBe(0);
    expect(deps.error).toHaveBeenCalled();
  });

  it("Phase3 finding8: runCli は deps の想定外の例外を握り潰さず伝播する(ボトムの .catch() が最後の安全網である前提を保証する)", async () => {
    const deps = makeDeps({
      runSetup: vi.fn(() => {
        throw new Error("boom: unexpected bug in runSetup");
      }),
    });
    // ここで runCli 自身が黙って例外を握り潰す(=undefined を返す等)ようになると、
    // index.ts 末尾の .catch() 安全網が意味を失う。伝播することを固定して防ぐ。
    await expect(runCli(["setup"], deps)).rejects.toThrow("boom: unexpected bug in runSetup");
  });
});
