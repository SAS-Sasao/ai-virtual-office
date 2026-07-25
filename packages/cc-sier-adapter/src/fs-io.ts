// cli.ts が使う fs I/O ヘルパー。parse-masters.ts / import-org.ts / attribution-index.ts は
// 純関数のまま保つため、fs に触れる処理はこのファイルと cli.ts だけに閉じ込める
// （テストは注入した FsDeps 経由で行い、real fs は cli.ts の統合テスト・AC-2 実測でのみ使う）。
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FsDeps {
  existsAndReadFile(path: string): string | undefined;
  readdir(path: string): string[];
  mkdir(path: string): void;
  writeFile(path: string, content: string): void;
  rename(from: string, to: string): void;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** 実 fs を使う既定実装。テストでは差し替える。 */
export const defaultFsDeps: FsDeps = {
  existsAndReadFile(path: string): string | undefined {
    try {
      return readFileSync(path, "utf-8");
    } catch (err) {
      if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        return undefined;
      }
      throw err;
    }
  },
  readdir(path: string): string[] {
    try {
      return readdirSync(path);
    } catch (err) {
      if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        return [];
      }
      throw err;
    }
  },
  mkdir(path: string): void {
    mkdirSync(path, { recursive: true });
  },
  writeFile(path: string, content: string): void {
    writeFileSync(path, content, "utf-8");
  },
  rename(from: string, to: string): void {
    renameSync(from, to);
  },
};

/** JSON の正本表現。2 スペースインデント + 末尾改行で固定し、再実行時のバイト同一性を保つ。 */
export function serializeJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * 一時ファイル書き込み + rename によるアトミックな書き込み（M1-2b の fs-safety と同方針の
 * 最小実装。バックアップ・TOCTOU 検証は行わない＝スコープ外。詳細は設計メモ参照）。
 */
export function writeFileAtomic(fs: FsDeps, targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  fs.mkdir(dir);
  const tmpPath = join(dir, `.ai-office-adapter-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFile(tmpPath, content);
  fs.rename(tmpPath, targetPath);
}
