#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolvePaths as defaultResolvePaths, type ResolvedPaths } from "./paths.js";
import { runSetup as defaultRunSetup, type RunSetupResult } from "./setup.js";
import { runTeardown as defaultRunTeardown, type RunTeardownResult } from "./teardown.js";
import { runDoctor as defaultRunDoctor, type DoctorReport } from "./doctor.js";

const DEFAULT_PORT = 4100;

export const HELP_TEXT = `ai-office — Claude Code hooks を ai-virtual-office Relay に配線する CLI

使い方:
  ai-office setup [--project] [--port <n>] [--dry-run] [--force]
      Claude Code の settings.json に観測 hooks（8イベント）を追記する。
      既定は user スコープ（~/.claude/settings.json）。--project で
      カレントディレクトリの .claude/settings.json を対象にする。

  ai-office teardown [--project] [--keep-backup]
      setup が追加した hooks（#ai-office:cli マーカー付き）のみを除去する。
      手書きの hooks には触れない。

  ai-office doctor [--project] [--port <n>]
      hooks 導入状態・Relay 疎通・イベント到達・競合検知を診断する。

  ai-office --help
      このヘルプを表示する。

オプション:
  --project      user スコープの代わりに <cwd>/.claude/settings*.json を対象にする
  --port <n>     Relay のポート（既定 4100）
  --dry-run      setup: 実際には書き込まず、変更予定のみ表示する
  --force        setup: 本リポジトリ自身へのガードを無視して実行する
  --keep-backup  teardown: 成功後もバックアップファイルを削除しない
`;

export interface CliFlags {
  dryRun: boolean;
  project: boolean;
  force: boolean;
  keepBackup: boolean;
  port: number | undefined;
  help: boolean;
}

/** `process.argv.slice(2)` 相当の素の配列を解析する（外部パーサ依存なし）。 */
export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    dryRun: false,
    project: false,
    force: false,
    keepBackup: false,
    port: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--project":
        flags.project = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "--keep-backup":
        flags.keepBackup = true;
        break;
      case "--port": {
        const value = argv[i + 1];
        if (value !== undefined) {
          flags.port = Number(value);
          i += 1;
        }
        break;
      }
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        break;
    }
  }

  return flags;
}

function findCommand(argv: string[]): string | undefined {
  return argv.find((a) => !a.startsWith("-"));
}

/** index.ts が実際に呼ぶ副作用（fs/network/console）をまとめた DI ポイント。単体テストで差し替える。 */
export interface CliDeps {
  resolvePaths: typeof defaultResolvePaths;
  runSetup: (options: Parameters<typeof defaultRunSetup>[0]) => RunSetupResult;
  runTeardown: (options: Parameters<typeof defaultRunTeardown>[0]) => RunTeardownResult;
  runDoctor: (options: Parameters<typeof defaultRunDoctor>[0]) => Promise<DoctorReport>;
  log: (message: string) => void;
  error: (message: string) => void;
}

export const defaultDeps: CliDeps = {
  resolvePaths: defaultResolvePaths,
  runSetup: defaultRunSetup,
  runTeardown: defaultRunTeardown,
  runDoctor: defaultRunDoctor,
  // eslint-disable-next-line no-console
  log: (message: string) => console.log(message),
  // eslint-disable-next-line no-console
  error: (message: string) => console.error(message),
};

function targetPathFor(paths: ResolvedPaths, project: boolean): string {
  return project ? paths.projectSettingsPath : paths.userSettingsPath;
}

function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const h of report.hooks) {
    if (!h.exists) {
      lines.push(`  [${h.scope}] ${h.path}: not found`);
      continue;
    }
    if (h.parseError) {
      lines.push(`  [${h.scope}] ${h.path}: invalid JSON (skipped)`);
      continue;
    }
    const wiredCount = h.installedSlugs.length + h.duplicateSlugs.length;
    const breakdown = h.duplicateSlugs.length > 0 ? ` (of which ${h.duplicateSlugs.length} via unmarked hand-written hooks)` : "";
    lines.push(`  [${h.scope}] ${h.path}: ${wiredCount}/8 installed${breakdown}`);
    if (h.duplicateSlugs.length > 0) {
      lines.push(
        `    warning: unmarked hook(s) already targeting the same URL for: ${h.duplicateSlugs.join(", ")} (possible duplicate delivery; consider running setup once the hand-written entry is removed, so it gets the #ai-office:cli marker)`,
      );
    }
  }

  if (report.relay.reachable) {
    lines.push(`  relay: reachable (receivedCount=${report.relay.health?.receivedCount ?? 0})`);
    if (report.eventReachedWarning) {
      lines.push("    warning: no event received yet. Operate Claude Code once, then re-run doctor.");
    }
  } else {
    lines.push(`  relay: unreachable (${report.relay.error ?? "unknown error"})`);
  }

  lines.push(report.exitCode === 0 ? "doctor: OK" : "doctor: FAILED");
  return lines.join("\n");
}

/**
 * CLI 本体。実際の process.argv/exitCode/console からは分離してあり、
 * argv と deps を DI して単体テストできる。
 */
export async function runCli(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const flags = parseFlags(argv);
  const command = findCommand(argv);

  if (flags.help || !command) {
    deps.log(HELP_TEXT);
    return 0;
  }

  const paths = deps.resolvePaths();
  const port = flags.port ?? DEFAULT_PORT;

  switch (command) {
    case "help": {
      deps.log(HELP_TEXT);
      return 0;
    }
    case "setup": {
      const scope = flags.project ? "project" : "user";
      const result = deps.runSetup({
        targetPath: targetPathFor(paths, flags.project),
        scope,
        port,
        dryRun: flags.dryRun,
        force: flags.force,
      });
      deps.log(result.message);
      return result.exitCode;
    }
    case "teardown": {
      const result = deps.runTeardown({
        targetPath: targetPathFor(paths, flags.project),
        keepBackup: flags.keepBackup,
      });
      deps.log(result.message);
      return result.exitCode;
    }
    case "doctor": {
      const report = await deps.runDoctor({ paths, port });
      deps.log(formatDoctorReport(report));
      return report.exitCode;
    }
    default: {
      deps.error(`unknown command: ${command}`);
      deps.log(HELP_TEXT);
      return 1;
    }
  }
}

// `npx ai-office` / `node_modules/.bin/ai-office` はシンボリックリンク経由で実行
// されるため、process.argv[1] は必ずしも import.meta.url と文字列一致しない
// （argv[1] はリンクのパス、import.meta.url は解決済みの実体パス）。realpath で
// 両者を解決してから比較することで、bin 経由の起動でも確実にエントリポイントとして
// 認識する（さもないとヘルプすら表示されず exit 0 で無言終了してしまう）。
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  // 想定外の例外（deps 実装のバグ等）が Node の生スタックトレースで
  // プロセスを落とすのではなく、1行のメッセージ + 非0終了で収まるようにする
  // 安全網（Phase3 レビュー finding8）。個々のコマンドが自前で扱えるエラー
  // （壊れた JSON・読み取り失敗・書き込み失敗等）は runSetup/runTeardown/
  // runDoctor がすでに正常系として返しており、ここに到達するのはそれらの
  // 想定外のバグのみ。
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`ai-office: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
