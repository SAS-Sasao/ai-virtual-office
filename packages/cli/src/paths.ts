import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ai-office setup/doctor/teardown が読み書きする 4 つの設定ファイルパス。
 * user/project × settings.json/settings.local.json の組み合わせ。
 */
export interface ResolvedPaths {
  userSettingsPath: string;
  projectSettingsPath: string;
  userLocalSettingsPath: string;
  projectLocalSettingsPath: string;
}

export interface ResolvePathsOptions {
  /** 既定は process.cwd()。--project スコープの基点。 */
  cwd?: string;
  /** 既定は os.homedir()。user スコープの基点。 */
  home?: string;
  /** 既定は process.env。4 パスはそれぞれ専用の env で個別に差し替え可能。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 4 パスを解決する唯一の resolver。doctor/setup/teardown はここから得た
 * ResolvedPaths のみを使い、env や homedir()/cwd() を自分で直接参照しない
 * （テストから実行環境の実ファイルを完全に隔離するため）。
 */
export function resolvePaths(options: ResolvePathsOptions = {}): ResolvedPaths {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  const userSettingsPath = env.AI_OFFICE_USER_SETTINGS_PATH ?? join(home, ".claude", "settings.json");
  const projectSettingsPath =
    env.AI_OFFICE_PROJECT_SETTINGS_PATH ?? join(cwd, ".claude", "settings.json");
  const userLocalSettingsPath =
    env.AI_OFFICE_USER_LOCAL_SETTINGS_PATH ?? join(home, ".claude", "settings.local.json");
  const projectLocalSettingsPath =
    env.AI_OFFICE_PROJECT_LOCAL_SETTINGS_PATH ?? join(cwd, ".claude", "settings.local.json");

  return { userSettingsPath, projectSettingsPath, userLocalSettingsPath, projectLocalSettingsPath };
}
