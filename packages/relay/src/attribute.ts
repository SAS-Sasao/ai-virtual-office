import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AttributionIndexSchema, type AttributionIndex } from "@ai-office/protocol";

/**
 * 帰属推定の汎用 lookup（CC-SIer 非依存。FR-4）。
 *
 * `attribution.json`（`AttributionIndexSchema`、正本は packages/protocol）だけを読み、
 * CC-SIer の知識（masters の形式・組織構造）は一切持ち込まない。CC-SIer 固有の変換は
 * すべて packages/cc-sier-adapter/src/attribution-index.ts 側の責務（プログレッシブ・
 * ディスクロージャ）。
 *
 * NFR-4（最重要制約）: cwd はログ・エラーメッセージ・例外文字列に一切出さない。
 * `.git/HEAD` 読取失敗を含む全ての例外はここで無言のまま握り潰し、undefined /
 * フィールド無しに落とす。console.log/warn/error を一切呼び出さない。
 */

/** 帰属推定の結果。一致しなかったフィールドはキー自体を含めない（規則 4）。 */
export interface Attribution {
  org?: string;
  dept?: string;
  role?: string;
}

/**
 * `cwd` からブランチ名を読み取る関数（DI）。読み取れない・detached HEAD・
 * worktree/submodule（`.git` がファイル）・`.git` 不在などは例外を投げるか
 * `undefined` を返すことで表現してよい（呼び出し側が両方を undefined として扱う）。
 */
export type ReadBranch = (cwd: string) => string | undefined;

export type Attributor = (raw: unknown) => Attribution;

export interface CreateAttributorOptions {
  /** attribution.json の内容（AttributionIndexSchema）。 */
  index: AttributionIndex;
  /**
   * `.git/HEAD` 読取の DI（既定は同期 fs read + cwd 単位キャッシュ）。
   * テストから fixture 値を直接返す関数を注入できる。
   */
  readBranch?: ReadBranch;
  /** 現在時刻を返す関数（既定 Date.now）。既定 readBranch のキャッシュ TTL 判定に使う。 */
  now?: () => number;
}

const HEAD_CACHE_TTL_MS = 60_000;

/**
 * 既定の readBranch: `<cwd>/.git/HEAD` を同期 read し、`ref: refs/heads/<branch>`
 * 形式からブランチ名を取り出す。detached HEAD（内容が SHA）・`.git` がファイル
 * （worktree/submodule）・`.git` 不在はすべて undefined に落とす（上方探索はしない）。
 * cwd 単位で TTL 60 秒キャッシュする（時刻は `now` から注入）。
 */
function createDefaultReadBranch(now: () => number): ReadBranch {
  const cache = new Map<string, { branch: string | undefined; expiresAt: number }>();

  return (cwd: string): string | undefined => {
    const nowMs = now();
    const cached = cache.get(cwd);
    if (cached && nowMs < cached.expiresAt) {
      return cached.branch;
    }

    let branch: string | undefined;
    try {
      const content = readFileSync(join(cwd, ".git", "HEAD"), "utf8").trim();
      const match = /^ref:\s+refs\/heads\/(.+)$/.exec(content);
      branch = match ? match[1] : undefined;
    } catch {
      // ENOENT（.git 不在）/ ENOTDIR（.git がファイル）/ その他すべてを undefined に
      // 落とす。例外オブジェクト・パスは一切外に出さない（NFR-4）。
      branch = undefined;
    }

    cache.set(cwd, { branch, expiresAt: nowMs + HEAD_CACHE_TTL_MS });
    return branch;
  };
}

/** prefix が cwd と一致、または cwd がその直下のサブディレクトリであるかを判定する。 */
function matchesRepoPrefix(cwd: string, prefix: string): boolean {
  const normalized = prefix.replace(/\/+$/, "");
  return cwd === normalized || cwd.startsWith(`${normalized}/`);
}

/** branch が `{org}/...` 形式で org に一致するかを判定する。 */
function matchesBranchOrg(branch: string, org: string): boolean {
  return branch === org || branch.startsWith(`${org}/`);
}

export function createAttributor(options: CreateAttributorOptions): Attributor {
  const { index, now = () => Date.now() } = options;
  const readBranch = options.readBranch ?? createDefaultReadBranch(now);

  return (raw: unknown): Attribution => {
    try {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
      }
      const record = raw as Record<string, unknown>;

      // 規則 3（最優先。規則 1/2 より詳細な dept/role を運べるため、org も含めて上書きする）。
      const toolInput = record.tool_input;
      if (typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)) {
        const subagentType = (toolInput as Record<string, unknown>).subagent_type;
        if (typeof subagentType === "string") {
          const match = index.subagents[subagentType];
          if (match) {
            return { org: match.org, dept: match.dept, role: match.role };
          }
        }
      }

      const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
      if (cwd === undefined) {
        return {};
      }

      // 規則 1
      for (const entry of index.repoPrefixes) {
        if (matchesRepoPrefix(cwd, entry.prefix)) {
          return { org: entry.org };
        }
      }

      // 規則 2（規則 1 で org が確定しなかった場合のみ）
      let branch: string | undefined;
      try {
        branch = readBranch(cwd);
      } catch {
        branch = undefined;
      }
      if (branch !== undefined) {
        for (const org of index.branchOrgs) {
          if (matchesBranchOrg(branch, org)) {
            return { org };
          }
        }
      }

      // 規則 4
      return {};
    } catch {
      // 想定外の例外もすべて握り潰し、帰属なしに落とす（NFR-2 と同じ「絶対にブロック
      // しない」思想を帰属推定にも適用する。cwd を例外に含めない）。
      return {};
    }
  };
}

const DEFAULT_ATTRIBUTION_RELATIVE_PATH = join(".ai-office", "layouts", "attribution.json");

/**
 * attribution.json（cc-sier-adapter が生成）のパスを解決する。
 * `AI_OFFICE_ATTRIBUTION_PATH` > 既定 `~/.ai-office/layouts/attribution.json`。
 *
 * `env` は DI 可能（既定 `process.env`）。`resolveSeqPath`（seq.ts）と同じ設計方針。
 */
export function resolveAttributionPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_OFFICE_ATTRIBUTION_PATH ?? join(homedir(), DEFAULT_ATTRIBUTION_RELATIVE_PATH);
}

export interface LoadAttributorOptions {
  /** attribution.json のパス（通常は `resolveAttributionPath()` の戻り値）。 */
  path: string;
  /** `createAttributor` にそのまま渡す時刻源（既定 Date.now）。 */
  now?: () => number;
  /** ファイル読み取りの DI（既定は `path` に対する同期 fs read）。テストから注入可能。 */
  readFileSync?: (path: string) => string;
  /**
   * 起動時診断ログの出力先（既定 `console.log`）。ファイル無し・パース失敗・
   * スキーマ検証失敗のいずれでも 1 行だけ出す。**内容ではなくパスのみ**を含める
   * （NFR-4）。
   */
  log?: (message: string) => void;
}

/**
 * attribution.json を読み込み、`Attributor` を組み立てる。
 *
 * **graceful degradation**: ファイルが存在しない・読み取れない・JSON として
 * 不正・`AttributionIndexSchema` の検証に失敗した場合はすべて「帰属なしで
 * 正常起動」に倒す（no-op な Attributor を返すだけで、決して throw しない）。
 * M0 以来の利用者（attribution.json を持たない環境）を壊さないための設計。
 */
export function loadAttributor(options: LoadAttributorOptions): Attributor {
  const {
    path,
    now,
    readFileSync: readFileImpl = (p: string) => readFileSync(p, "utf8"),
    log = (message: string) => console.log(message),
  } = options;

  let raw: string;
  try {
    raw = readFileImpl(path);
  } catch {
    // ファイル不在・読み取り不可のいずれも同じ扱い（区別してもテスト・診断上
    // 意味が薄く、余計な情報を出すリスクだけが増えるため一本化する）。
    log(`relay: no attribution index found at ${path}; starting without attribution`);
    return () => ({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`relay: attribution index at ${path} is not valid JSON; starting without attribution`);
    return () => ({});
  }

  const result = AttributionIndexSchema.safeParse(parsed);
  if (!result.success) {
    log(`relay: attribution index at ${path} failed schema validation; starting without attribution`);
    return () => ({});
  }

  return createAttributor({ index: result.data, now });
}
