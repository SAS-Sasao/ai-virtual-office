import { readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { removeHooks } from "./merge.js";
import {
  SettingsParseError,
  SettingsReadError,
  SettingsWriteError,
  ToctouError,
  loadSettings,
  writeSettingsSafely,
} from "./fs-safety.js";

export interface RunTeardownOptions {
  targetPath: string;
  /** true の場合、成功後もバックアップを削除しない（既定は削除して痕跡ゼロにする）。 */
  keepBackup?: boolean;
  now?: () => Date;
}

export interface RunTeardownResult {
  ok: boolean;
  exitCode: number;
  removedCount: number;
  message: string;
}

export function runTeardown(options: RunTeardownOptions): RunTeardownResult {
  const { targetPath, keepBackup = false, now } = options;

  let loaded;
  try {
    loaded = loadSettings(targetPath);
  } catch (err) {
    if (err instanceof SettingsParseError || err instanceof SettingsReadError) {
      return { ok: false, exitCode: 1, removedCount: 0, message: err.message };
    }
    throw err;
  }

  if (!loaded.exists) {
    return { ok: true, exitCode: 0, removedCount: 0, message: `${targetPath} not found (nothing to remove)` };
  }

  const removed = removeHooks(loaded.parsed);

  if (removed.removedCount === 0) {
    return { ok: true, exitCode: 0, removedCount: 0, message: `no ai-office hooks found in ${targetPath}` };
  }

  const content = `${JSON.stringify(removed.settings, null, 2)}\n`;

  let writeResult;
  try {
    writeResult = writeSettingsSafely(targetPath, loaded.realPath, loaded.baseline, content, { now });
  } catch (err) {
    if (err instanceof ToctouError || err instanceof SettingsWriteError) {
      return { ok: false, exitCode: 1, removedCount: 0, message: err.message };
    }
    throw err;
  }

  // 要件 §5.1「痕跡ゼロ」を満たすため、成功時はバックアップを削除する（--keep-backup で保持可）。
  // teardown 自身が今回作成した分に加え、直近の setup 実行が残した分（AC-3 は
  // setup → teardown の一巡で痕跡ゼロを要求する）もあわせて掃除する。
  //
  // 掃除する対象は最大2件（今回 teardown 自身が作った分 + それを除いた中で
  // ファイル名の ISO8601 タイムスタンプが最も新しい1件）に限定する
  // （Phase3 レビュー finding7）。`*.ai-office-backup-*` に一致する全件を
  // 無差別に消すと、過去に `--keep-backup` で利用者が意図的に残したバックアップ
  // まで削除してしまうため。それより古いバックアップは「意図的に保持された
  // もの」とみなして一切触れない。best-effort（削除失敗があっても teardown
  // 自体の成否には影響させない）。
  if (!keepBackup) {
    const dir = dirname(loaded.realPath);
    const prefix = `${basename(loaded.realPath)}.ai-office-backup-`;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }

    const backups = entries.filter((e) => e.startsWith(prefix)).sort(); // ISO8601 なので昇順ソート可能
    const ownBackupName = writeResult.backupPath ? basename(writeResult.backupPath) : null;

    const toDelete: string[] = [];
    if (ownBackupName) toDelete.push(ownBackupName);

    const others = backups.filter((b) => b !== ownBackupName);
    if (others.length > 0) {
      // 直近(最新)の1件のみ = 直前の setup が残した分と推定できるもの
      toDelete.push(others[others.length - 1]);
    }

    for (const name of toDelete) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // best-effort
      }
    }
  }

  return {
    ok: true,
    exitCode: 0,
    removedCount: removed.removedCount,
    message: `removed ${removed.removedCount} hook(s) from ${targetPath}`,
  };
}
