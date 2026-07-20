import { dirname } from "node:path";
import { HOOKS_SPEC } from "./hooks-spec.js";
import { mergeHooks } from "./merge.js";
import { isInsideNamedRepo } from "./repo-guard.js";
import {
  SettingsParseError,
  SettingsReadError,
  SettingsWriteError,
  ToctouError,
  loadSettings,
  writeSettingsSafely,
} from "./fs-safety.js";

/** 本リポジトリ自身への誤爆を防ぐガード名（本リポジトリの package.json の name）。 */
const THIS_REPO_NAME = "ai-virtual-office";
const DEFAULT_PORT = 4100;

export interface RunSetupOptions {
  /** 書き込み先の settings.json パス（呼び出し側が既に scope に応じて解決済みのもの）。 */
  targetPath: string;
  /** "project" のときのみリポジトリガードを適用する。 */
  scope: "user" | "project";
  /** Relay のポート（既定 4100）。生成する curl コマンドの宛先に使う。 */
  port?: number;
  dryRun?: boolean;
  /** リポジトリガードを無視して強制実行する。 */
  force?: boolean;
  /** リポジトリガードの上方探索の起点（既定は dirname(targetPath)）。テスト DI 用。 */
  repoGuardCwd?: string;
  /** リポジトリガードが警戒する package.json の name（既定 "ai-virtual-office"）。テスト DI 用。 */
  repoGuardName?: string;
  /** バックアップファイル名の時刻源（DI、決定論的テスト用）。 */
  now?: () => Date;
}

export interface RunSetupResult {
  ok: boolean;
  exitCode: number;
  addedSlugs: string[];
  skippedIdempotentSlugs: string[];
  skippedDuplicateSlugs: string[];
  /** 壊れた/未知形状の既存値のため追記をスキップした slug（Phase3 finding1）。 */
  skippedMalformedSlugs: string[];
  backupPath: string | null;
  dryRun: boolean;
  message: string;
}

function malformedWarning(skippedMalformedSlugs: string[]): string {
  if (skippedMalformedSlugs.length === 0) return "";
  return ` (warning: existing config for ${skippedMalformedSlugs.join(", ")} is not in the expected array shape; left untouched)`;
}

export function runSetup(options: RunSetupOptions): RunSetupResult {
  const {
    targetPath,
    scope,
    port = DEFAULT_PORT,
    dryRun = false,
    force = false,
    repoGuardCwd,
    repoGuardName = THIS_REPO_NAME,
    now,
  } = options;

  if (scope === "project" && !force) {
    const guardStart = repoGuardCwd ?? dirname(targetPath);
    if (isInsideNamedRepo(guardStart, repoGuardName)) {
      return {
        ok: false,
        exitCode: 1,
        addedSlugs: [],
        skippedIdempotentSlugs: [],
        skippedDuplicateSlugs: [],
        skippedMalformedSlugs: [],
        backupPath: null,
        dryRun,
        message: `aborted: ${guardStart} is inside the "${repoGuardName}" repository itself. Use --force to override, or run from outside this repository.`,
      };
    }
  }

  let loaded;
  try {
    loaded = loadSettings(targetPath);
  } catch (err) {
    if (err instanceof SettingsParseError || err instanceof SettingsReadError) {
      return {
        ok: false,
        exitCode: 1,
        addedSlugs: [],
        skippedIdempotentSlugs: [],
        skippedDuplicateSlugs: [],
        skippedMalformedSlugs: [],
        backupPath: null,
        dryRun,
        message: err.message,
      };
    }
    throw err;
  }

  const existing = loaded.exists ? loaded.parsed : { hooks: {} };
  const merged = mergeHooks(existing, HOOKS_SPEC, port);
  const warning = malformedWarning(merged.skippedMalformedSlugs);

  if (dryRun) {
    return {
      ok: true,
      exitCode: 0,
      addedSlugs: merged.addedSlugs,
      skippedIdempotentSlugs: merged.skippedIdempotentSlugs,
      skippedDuplicateSlugs: merged.skippedDuplicateSlugs,
      skippedMalformedSlugs: merged.skippedMalformedSlugs,
      backupPath: null,
      dryRun: true,
      message: `[dry-run] would add ${merged.addedSlugs.length} hook(s) to ${targetPath}${warning}`,
    };
  }

  if (merged.addedSlugs.length === 0) {
    return {
      ok: true,
      exitCode: 0,
      addedSlugs: [],
      skippedIdempotentSlugs: merged.skippedIdempotentSlugs,
      skippedDuplicateSlugs: merged.skippedDuplicateSlugs,
      skippedMalformedSlugs: merged.skippedMalformedSlugs,
      backupPath: null,
      dryRun: false,
      message: `${targetPath} is already up to date (0 hooks added)${warning}`,
    };
  }

  const content = `${JSON.stringify(merged.settings, null, 2)}\n`;

  try {
    const writeResult = writeSettingsSafely(targetPath, loaded.realPath, loaded.baseline, content, { now });
    return {
      ok: true,
      exitCode: 0,
      addedSlugs: merged.addedSlugs,
      skippedIdempotentSlugs: merged.skippedIdempotentSlugs,
      skippedDuplicateSlugs: merged.skippedDuplicateSlugs,
      skippedMalformedSlugs: merged.skippedMalformedSlugs,
      backupPath: writeResult.backupPath,
      dryRun: false,
      message: `added ${merged.addedSlugs.length} hook(s) to ${targetPath}${warning}`,
    };
  } catch (err) {
    if (err instanceof ToctouError || err instanceof SettingsWriteError) {
      return {
        ok: false,
        exitCode: 1,
        addedSlugs: [],
        skippedIdempotentSlugs: merged.skippedIdempotentSlugs,
        skippedDuplicateSlugs: merged.skippedDuplicateSlugs,
        skippedMalformedSlugs: merged.skippedMalformedSlugs,
        backupPath: null,
        dryRun: false,
        message: err.message,
      };
    }
    throw err;
  }
}
