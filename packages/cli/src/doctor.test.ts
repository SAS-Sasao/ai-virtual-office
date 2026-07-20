import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "./setup.js";
import { runDoctor } from "./doctor.js";
import { MARKER } from "./hooks-spec.js";

function makeTmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "ai-office-doctor-"));
  return {
    dir,
    paths: {
      userSettingsPath: join(dir, "user-settings.json"),
      projectSettingsPath: join(dir, "project-settings.json"),
      userLocalSettingsPath: join(dir, "user-settings.local.json"),
      projectLocalSettingsPath: join(dir, "project-settings.local.json"),
    },
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

describe("runDoctor", () => {
  it("AC-7: setup 直後・イベント未受信でも hooks 導入済み + Relay 疎通ありなら exit 0（警告のみ）", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      writeFileSync(paths.userSettingsPath, JSON.stringify({ hooks: {} }), "utf-8");
      runSetup({ targetPath: paths.userSettingsPath, scope: "user", port: 4100 });

      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          ok: true,
          version: "0.0.0",
          testMode: false,
          pid: 123,
          port: 4100,
          receivedCount: 0,
          lastEventAt: null,
        }),
      );

      const report = await runDoctor({ paths, port: 4100, fetchImpl });

      expect(report.exitCode).toBe(0);
      expect(report.fatalReasons).toEqual([]);
      expect(report.eventReachedWarning).toBe(true);
      expect(report.hooksInstalled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC-7b: イベント到達済みなら警告が消え、receivedCount が反映される", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      writeFileSync(paths.userSettingsPath, JSON.stringify({ hooks: {} }), "utf-8");
      runSetup({ targetPath: paths.userSettingsPath, scope: "user", port: 4100 });

      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          ok: true,
          version: "0.0.0",
          testMode: false,
          pid: 123,
          port: 4100,
          receivedCount: 1,
          lastEventAt: 1_700_000_000_000,
        }),
      );

      const report = await runDoctor({ paths, port: 4100, fetchImpl });

      expect(report.exitCode).toBe(0);
      expect(report.eventReachedWarning).toBe(false);
      expect(report.relay.health?.receivedCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC-8: Relay 不通なら exit 1（fatalReasons に relay-unreachable）", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      writeFileSync(paths.userSettingsPath, JSON.stringify({ hooks: {} }), "utf-8");
      runSetup({ targetPath: paths.userSettingsPath, scope: "user", port: 4100 });

      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });

      const report = await runDoctor({ paths, port: 4100, fetchImpl });

      expect(report.exitCode).toBe(1);
      expect(report.fatalReasons).toContain("relay-unreachable");
      expect(report.relay.reachable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC-8: hooks 未導入なら exit 1（fatalReasons に hooks-not-installed）", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      // setup していない ＝ user/project どちらも 0/8
      writeFileSync(paths.userSettingsPath, JSON.stringify({ hooks: {} }), "utf-8");

      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          ok: true,
          version: "0.0.0",
          testMode: false,
          pid: 123,
          port: 4100,
          receivedCount: 0,
          lastEventAt: null,
        }),
      );

      const report = await runDoctor({ paths, port: 4100, fetchImpl });

      expect(report.exitCode).toBe(1);
      expect(report.fatalReasons).toContain("hooks-not-installed");
      expect(report.hooksInstalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project スコープで導入済みでも hooksInstalled は true になる", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      writeFileSync(paths.projectSettingsPath, JSON.stringify({ hooks: {} }), "utf-8");
      runSetup({ targetPath: paths.projectSettingsPath, scope: "project", port: 4100, force: true });

      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          ok: true,
          version: "0.0.0",
          testMode: false,
          pid: 123,
          port: 4100,
          receivedCount: 0,
          lastEventAt: null,
        }),
      );

      const report = await runDoctor({ paths, port: 4100, fetchImpl });
      expect(report.hooksInstalled).toBe(true);
      expect(report.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC-11b 相当: マーカー無しの同等 hook を検出したら警告として報告する（exitCode には影響しない）", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      writeFileSync(
        paths.userSettingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "curl -s -X POST http://localhost:4100/hooks/session-start -H 'Content-Type: application/json' -d @- --max-time 2 || true",
                  },
                ],
              },
            ],
          },
        }),
        "utf-8",
      );

      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          ok: true,
          version: "0.0.0",
          testMode: false,
          pid: 123,
          port: 4100,
          receivedCount: 0,
          lastEventAt: null,
        }),
      );

      const report = await runDoctor({ paths, port: 4100, fetchImpl });
      const userStatus = report.hooks.find((h) => h.scope === "user");
      expect(userStatus?.duplicateSlugs).toContain("session-start");
      // 重複は警告のみで致命ではない(exit code は他条件次第。ここでは hooks 未導入で fatal になる)
      expect(report.fatalReasons).not.toContain("duplicate-hooks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Phase3 finding4: マーカー無しの手書き hook で配線が成立している slug も hooksInstalled に含め、exit 0 になる", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      writeFileSync(paths.userSettingsPath, JSON.stringify({ hooks: {} }), "utf-8");
      runSetup({ targetPath: paths.userSettingsPath, scope: "user", port: 4100 });

      // 8件のうち1件だけ、完全体マーカーを剥がして「マーカー無しの手書き」相当にする
      // （setup は「already up to date」exit0、doctor は素朴には「7/8」で exit1 に
      // なってしまっていた矛盾を再現する）。
      const raw = readFileSync(paths.userSettingsPath, "utf-8");
      const mutated = raw.replace(MARKER, "");
      writeFileSync(paths.userSettingsPath, mutated, "utf-8");

      const setupAgain = runSetup({ targetPath: paths.userSettingsPath, scope: "user", port: 4100 });
      // setup 視点では「配線は成立している(重複扱いで追加しない)」ので 0 added, exit 0
      expect(setupAgain.addedSlugs).toHaveLength(0);
      expect(setupAgain.exitCode).toBe(0);

      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          ok: true,
          version: "0.0.0",
          testMode: false,
          pid: 123,
          port: 4100,
          receivedCount: 0,
          lastEventAt: null,
        }),
      );

      const report = await runDoctor({ paths, port: 4100, fetchImpl });
      const userStatus = report.hooks.find((h) => h.scope === "user");
      expect(userStatus?.installedSlugs.length).toBe(7);
      expect(userStatus?.duplicateSlugs.length).toBe(1);
      // 7 marker + 1 duplicate = 8、配線としては成立しているので exit 0
      expect(report.hooksInstalled).toBe(true);
      expect(report.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC-13: doctor は /health 以外のエンドポイントを一切叩かない（副作用ゼロ）", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      writeFileSync(paths.userSettingsPath, JSON.stringify({ hooks: {} }), "utf-8");
      runSetup({ targetPath: paths.userSettingsPath, scope: "user", port: 4100 });

      const fetchImpl = vi.fn(async (url: string) =>
        jsonResponse({
          ok: true,
          version: "0.0.0",
          testMode: false,
          pid: 123,
          port: 4100,
          receivedCount: 0,
          lastEventAt: null,
        }),
      );

      await runDoctor({ paths, port: 4100, fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const calledUrl = fetchImpl.mock.calls[0][0];
      expect(calledUrl).toBe("http://localhost:4100/health");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4 パスすべて doctor の入力として DI 可能（env や実 fs パスに依存しない）", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      // わざと全部存在しないファイルにする — 実 fs のホームディレクトリを一切読まないことの確認
      const fetchImpl = vi.fn(async () => {
        throw new Error("unreachable");
      });
      const report = await runDoctor({ paths, port: 4100, fetchImpl });
      expect(report.hooks.map((h) => h.path).sort()).toEqual(
        [paths.userSettingsPath, paths.projectSettingsPath, paths.userLocalSettingsPath, paths.projectLocalSettingsPath].sort(),
      );
      for (const h of report.hooks) {
        expect(h.exists).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2秒タイムアウトを AbortSignal で fetch に渡す", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      let capturedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        capturedSignal = init?.signal;
        return jsonResponse({
          ok: true,
          version: "0.0.0",
          testMode: false,
          pid: 1,
          port: 4100,
          receivedCount: 0,
          lastEventAt: null,
        });
      });

      await runDoctor({ paths, port: 4100, fetchImpl, timeoutMs: 2000 });
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("壊れた JSON の設定ファイルがあってもクラッシュしない（parseError として報告）", async () => {
    const { dir, paths } = makeTmpPaths();
    try {
      writeFileSync(paths.userSettingsPath, "{ not valid json", "utf-8");
      const fetchImpl = vi.fn(async () => {
        throw new Error("unreachable");
      });
      const report = await runDoctor({ paths, port: 4100, fetchImpl });
      const userStatus = report.hooks.find((h) => h.scope === "user");
      expect(userStatus?.parseError).toBe(true);
      expect(report.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
