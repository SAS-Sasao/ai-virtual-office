// cli.ts の単体テスト用インメモリ FsDeps 実装。実 fs には一切触れない
// （`~/.ai-office/` へ書き込まない、という制約を単体テストレベルで機械的に満たす）。
import type { FsDeps } from "../fs-io.js";

export interface FakeFs extends FsDeps {
  files: Map<string, string>;
}

export function createFakeFs(initialFiles: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(initialFiles));

  return {
    files,
    existsAndReadFile(path: string): string | undefined {
      return files.get(path);
    },
    readdir(path: string): string[] {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const [first] = rest.split("/");
        if (first) names.add(first);
      }
      return [...names].sort();
    },
    mkdir(_path: string): void {
      // インメモリ実装ではディレクトリを個別管理しない（ファイル書き込み時に暗黙生成される）。
    },
    writeFile(path: string, content: string): void {
      files.set(path, content);
    },
    rename(from: string, to: string): void {
      const content = files.get(from);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file, rename '${from}' -> '${to}'`), { code: "ENOENT" });
      }
      files.delete(from);
      files.set(to, content);
    },
  };
}

