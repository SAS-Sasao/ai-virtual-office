import { readFileSync as nodeReadFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CharacterSchema, OfficeLayoutSchema, type Character, type OfficeLayout } from "@ai-office/protocol";

/**
 * `GET /api/layout`（app/api/layout/route.ts）が読む office-layout.json /
 * characters.json のロードヘルパー。cc-sier-adapter の出力先解決
 * （`packages/cc-sier-adapter/src/cli.ts` の `resolveOutDir`）・relay の
 * attribution.json 解決（`packages/relay/src/attribute.ts` の
 * `resolveAttributionPath`）と同じ DI 方針（`env` 引数、既定 `process.env`）。
 */

const DEFAULT_LAYOUTS_RELATIVE_DIR = join(".ai-office", "layouts");

/**
 * レイアウトファイル群のディレクトリを解決する。
 * `AI_OFFICE_LAYOUTS_DIR` > 既定 `~/.ai-office/layouts/`。
 */
export function resolveLayoutsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_OFFICE_LAYOUTS_DIR ?? join(homedir(), DEFAULT_LAYOUTS_RELATIVE_DIR);
}

export interface OfficeLayoutData {
  layout: OfficeLayout | null;
  characters: Character[];
}

const EMPTY_RESULT: OfficeLayoutData = { layout: null, characters: [] };

const CharacterArraySchema = z.array(CharacterSchema);

export interface LoadOfficeLayoutOptions {
  /** ファイル読み取りの DI（既定は `path` に対する同期 fs read）。テストから注入可能。 */
  readFileSync?: (path: string) => string;
  /**
   * 異常系（不在・不正 JSON・スキーマ不一致）の診断ログ出力先（既定 `console.warn`）。
   * **ファイル内容・ディレクトリのフルパスは絶対に渡さない**（NFR-4 の精神をログにも
   * 適用する。events.ts の機微フィルタと同じ「漏らさない」思想）。1 回の異常系につき
   * 1 行のみ出す。
   */
  warn?: (message: string) => void;
}

const REIMPORT_HINT =
  "office-layout.json / characters.json が見つからないか現在のスキーマと一致しません。cc-sier-adapter で再インポートしてください。";

/**
 * `dir` 配下の office-layout.json / characters.json を読み、protocol スキーマ
 * （`OfficeLayoutSchema` / `CharacterSchema`）で parse してから返す。
 *
 * ファイル不在・JSON parse 不能・スキーマ不一致（`RoomSchema.door` 必須化前の
 * 旧形式を含む）のいずれでも例外を投げず `{layout: null, characters: []}` を
 * 返す（NFR-2 と同じ「壊れたデータで落ちない」思想）。呼び出し側
 * （`GET /api/layout`）は常に 200 を返せる。レイアウト未インポート環境でも
 * game 側がフォールバックレイアウトを描けるよう、例外的な形状ではなく
 * 常にこの形（layout/characters のペア）を返す契約を守る。
 */
export function loadOfficeLayoutData(dir: string, options: LoadOfficeLayoutOptions = {}): OfficeLayoutData {
  const readFileSync = options.readFileSync ?? ((path: string) => nodeReadFileSync(path, "utf-8"));
  const warn = options.warn ?? ((message: string) => console.warn(message));

  let layoutRaw: unknown;
  let charactersRaw: unknown;

  try {
    layoutRaw = JSON.parse(readFileSync(join(dir, "office-layout.json")));
    charactersRaw = JSON.parse(readFileSync(join(dir, "characters.json")));
  } catch {
    warn(`web: failed to read/parse office layout files (ignored). ${REIMPORT_HINT}`);
    return EMPTY_RESULT;
  }

  const layoutResult = OfficeLayoutSchema.safeParse(layoutRaw);
  const charactersResult = CharacterArraySchema.safeParse(charactersRaw);

  if (!layoutResult.success || !charactersResult.success) {
    warn(`web: office layout files did not match the current schema (ignored). ${REIMPORT_HINT}`);
    return EMPTY_RESULT;
  }

  return { layout: layoutResult.data, characters: charactersResult.data };
}
