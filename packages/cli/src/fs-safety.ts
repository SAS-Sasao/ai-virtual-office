import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** settings.json の JSON パースに失敗した場合に投げる。ファイルは一切書き換えない（AC-5）。 */
export class SettingsParseError extends Error {}

/**
 * settings.json の読み取り自体が失敗した場合（EISDIR/EACCES 等）に投げる。
 * `readFileSync`/`lstatSync` の生の例外を未捕捉のままスタックトレースで
 * プロセスを終了させないよう、型付きエラーに分類する（Phase3 レビュー finding8）。
 */
export class SettingsReadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SettingsReadError";
  }
}

/**
 * 読み取り時と書き込み直前とで mtime/size が変化していた場合に投げる（TOCTOU 検証、AC-12）。
 * 本体には一切触れない。
 */
export class ToctouError extends Error {}

/**
 * バックアップ作成・一時ファイル書き込み・rename のいずれかに失敗した場合に投げる
 * （ENOSPC/EACCES 等）。本体（realPath）は一切書き換えない（AC-12）。
 */
export class SettingsWriteError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SettingsWriteError";
  }
}

export interface FileBaseline {
  mtimeMs: number;
  size: number;
}

export interface LoadedSettings {
  /** 読み取り時点でファイルが存在したか。false の場合 parsed は undefined。 */
  exists: boolean;
  parsed: unknown;
  /** TOCTOU 検証の基準値。exists が false のときは null。 */
  baseline: FileBaseline | null;
  /**
   * 実際に読み書きすべき実体パス。targetPath がシンボリックリンクの場合は
   * その解決先。書き込みはこちらへ行い、リンク自体は rename で置換しない。
   */
  realPath: string;
}

/**
 * settings.json を読み込む。存在しない場合は exists:false を返す（エラーではない、
 * 新規作成として扱う）。JSON が壊れている場合のみ {@link SettingsParseError} を投げる。
 */
export function loadSettings(targetPath: string): LoadedSettings {
  let realPath = targetPath;
  if (existsSync(targetPath)) {
    const lst = lstatSync(targetPath);
    if (lst.isSymbolicLink()) {
      realPath = realpathSync(targetPath);
    }
  }

  if (!existsSync(realPath)) {
    return { exists: false, parsed: undefined, baseline: null, realPath };
  }

  let raw: string;
  let stat: ReturnType<typeof lstatSync>;
  try {
    raw = readFileSync(realPath, "utf-8");
    stat = lstatSync(realPath);
  } catch (err) {
    throw new SettingsReadError(
      `failed to read ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SettingsParseError(
      `invalid JSON in ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { exists: true, parsed, baseline: { mtimeMs: stat.mtimeMs, size: stat.size }, realPath };
}

export interface WriteSettingsOptions {
  /** バックアップファイル名の時刻。DI 可能（決定論的テストのため）。既定は現在時刻。 */
  now?: () => Date;
}

export interface WriteSettingsResult {
  /** 作成したバックアップファイルのパス。新規作成（baseline が null）の場合は null。 */
  backupPath: string | null;
}

function isoForFileName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * settings.json を破壊耐性つきで書き込む。
 *
 * 手順: (1) TOCTOU 再検証 → (2) バックアップ作成（既存ファイルのみ）→
 * (3) 一時ファイルへ書き込み → (4) rename でアトミックに置換。
 * (2)〜(4) のいずれかで失敗した場合、作成済みの一時ファイル/バックアップを
 * best-effort で削除してから {@link SettingsWriteError} を投げる（本体は無傷のまま）。
 */
export function writeSettingsSafely(
  targetPath: string,
  realPath: string,
  baseline: FileBaseline | null,
  content: string,
  options: WriteSettingsOptions = {},
): WriteSettingsResult {
  const { now = () => new Date() } = options;

  // TOCTOU 再検証: 読み取り時点の baseline と、書き込み直前の実際の状態を比較する。
  if (baseline !== null) {
    if (!existsSync(realPath)) {
      throw new ToctouError(`${targetPath} was removed since it was read`);
    }
    const stat = lstatSync(realPath);
    if (stat.mtimeMs !== baseline.mtimeMs || stat.size !== baseline.size) {
      throw new ToctouError(`${targetPath} was modified since it was read (TOCTOU)`);
    }
  }

  const dir = dirname(realPath);
  let backupPath: string | null = null;
  let tmpPath: string | null = null;

  try {
    mkdirSync(dir, { recursive: true });

    if (baseline !== null) {
      backupPath = `${realPath}.ai-office-backup-${isoForFileName(now())}`;
      copyFileSync(realPath, backupPath);
    }

    tmpPath = join(dir, `.ai-office-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, realPath);
    tmpPath = null; // rename 成功後はもう cleanup 不要
  } catch (err) {
    if (tmpPath && existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (backupPath && existsSync(backupPath)) {
      try {
        unlinkSync(backupPath);
      } catch {
        /* best-effort cleanup */
      }
    }
    throw new SettingsWriteError(`failed to write ${targetPath}`, err);
  }

  return { backupPath };
}
