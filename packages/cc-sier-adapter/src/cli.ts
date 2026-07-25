#!/usr/bin/env node
// ai-office-adapter — CC-SIer masters/*.md を office-layout.json / characters.json /
// attribution.json（packages/protocol のスキーマ）へ変換する CLI。
//
// I/O は本ファイルと fs-io.ts に閉じ込め、実際の変換ロジック（parse-masters.ts /
// import-org.ts / attribution-index.ts）は fs に触れない純関数のまま保つ。
import { realpathSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CharacterSchema,
  OfficeLayoutSchema,
  AttributionIndexSchema,
  type Character,
  type OfficeLayout,
} from "@ai-office/protocol";
import { z } from "zod";
import { defaultFsDeps, serializeJson, writeFileAtomic, type FsDeps } from "./fs-io.js";
import { importOrganizations, type OrgMastersInput } from "./import-org.js";
import { buildAttributionIndex, type AttributionRepoInput, type AttributionOrgInput } from "./attribution-index.js";
import { parseDepartments, parseRoles } from "./parse-masters.js";
import { compareCodePoint } from "./sort-util.js";

export const HELP_TEXT = `ai-office-adapter — CC-SIer masters/*.md をアプリ本体のスキーマへ変換する CLI

使い方:
  ai-office-adapter import [--repo <path>] [--out <dir>] [--dry-run]
      masters/*.md を解析し、office-layout.json / characters.json / attribution.json
      を生成する。再実行は冪等（custom: true の room/furniture は温存される）。

  ai-office-adapter --help
      このヘルプを表示する。

オプション:
  --repo <path>   CC-SIer 組織リポジトリのルート（省略時は ~/.ai-office/config.json の
                   organizations[]（type: cc-sier）を読む）
  --out <dir>     出力先ディレクトリ（省略時は AI_OFFICE_LAYOUTS_DIR、それも無ければ
                   ~/.ai-office/layouts/）
  --dry-run       実際には書き込まず、生成予定の概要のみ表示する
`;

export interface ImportFlags {
  repo: string | undefined;
  out: string | undefined;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): { command: string | undefined; flags: ImportFlags } {
  const flags: ImportFlags = { repo: undefined, out: undefined, dryRun: false, help: false };
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--repo": {
        flags.repo = argv[i + 1];
        i += 1;
        break;
      }
      case "--out": {
        flags.out = argv[i + 1];
        i += 1;
        break;
      }
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        if (!arg.startsWith("-") && command === undefined) {
          command = arg;
        }
        break;
    }
  }

  return { command, flags };
}

export interface CliDeps {
  fs: FsDeps;
  homedir: () => string;
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  error: (message: string) => void;
}

export const defaultDeps: CliDeps = {
  fs: defaultFsDeps,
  homedir: osHomedir,
  env: process.env,
  // eslint-disable-next-line no-console
  log: (message: string) => console.log(message),
  // eslint-disable-next-line no-console
  error: (message: string) => console.error(message),
};

const ConfigOrgSchema = z.object({
  repo: z.string().min(1),
  type: z.string().optional(),
});
const ConfigSchema = z.object({
  organizations: z.array(ConfigOrgSchema).optional(),
});

export type ResolveReposResult = { repos: string[] } | { repos: []; error: string };

/**
 * 対象リポジトリの一覧を決定する。`--repo` があればそれを最優先し、無ければ
 * `~/.ai-office/config.json` の `organizations[]`（type: "cc-sier"）を読む
 * （要件 §5.3。config.json は読むだけで、絶対に書き込まない）。
 */
export function resolveRepos(flags: ImportFlags, deps: CliDeps): ResolveReposResult {
  if (flags.repo) {
    return { repos: [flags.repo] };
  }

  const configPath = join(deps.homedir(), ".ai-office", "config.json");
  const raw = deps.fs.existsAndReadFile(configPath);
  if (raw === undefined) {
    return { repos: [], error: `--repo not given and config not found at ${configPath}` };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { repos: [], error: `invalid JSON in ${configPath}` };
  }

  const config = ConfigSchema.safeParse(parsedJson);
  if (!config.success) {
    return { repos: [], error: `unexpected shape in ${configPath} (expected { organizations: [...] })` };
  }

  const repos = (config.data.organizations ?? [])
    .filter((org) => org.type === undefined || org.type === "cc-sier")
    .map((org) => org.repo);

  if (repos.length === 0) {
    return { repos: [], error: `no cc-sier organizations configured in ${configPath}` };
  }

  return { repos };
}

/** 出力先ディレクトリを決定する: `--out` > `AI_OFFICE_LAYOUTS_DIR` > `~/.ai-office/layouts/`。 */
export function resolveOutDir(flags: ImportFlags, deps: CliDeps): string {
  if (flags.out) return flags.out;
  if (deps.env.AI_OFFICE_LAYOUTS_DIR) return deps.env.AI_OFFICE_LAYOUTS_DIR;
  return join(deps.homedir(), ".ai-office", "layouts");
}

export interface DiscoveredOrgs {
  orgIds: string[];
  activeOrgId: string | undefined;
}

/**
 * `<repoRoot>/.companies/` 配下の各組織ディレクトリを走査し、組織 ID の一覧
 * （codepoint 順。import-org.ts / attribution-index.ts の並び替えと同じ規則。
 * [[compareCodePoint]] 参照）と `.active` の内容を返す。
 */
export function discoverOrgs(repoRoot: string, fs: FsDeps): DiscoveredOrgs {
  const companiesDir = join(repoRoot, ".companies");
  const orgIds = fs
    .readdir(companiesDir)
    .filter((name) => !name.startsWith("."))
    .sort(compareCodePoint);
  const activeRaw = fs.existsAndReadFile(join(companiesDir, ".active"));
  const activeOrgId = activeRaw?.trim() ? activeRaw.trim() : undefined;
  return { orgIds, activeOrgId };
}

/** 1 組織分の masters/*.md を読む。存在しないファイルは undefined のまま（graceful）。 */
export function readOrgMasters(repoRoot: string, orgId: string, fs: FsDeps): OrgMastersInput {
  const dir = join(repoRoot, ".companies", orgId, "masters");
  return {
    orgId,
    organizationMd: fs.existsAndReadFile(join(dir, "organization.md")),
    departmentsMd: fs.existsAndReadFile(join(dir, "departments.md")),
    rolesMd: fs.existsAndReadFile(join(dir, "roles.md")),
  };
}

function loadExistingLayout(fs: FsDeps, layoutPath: string, warnings: string[]): OfficeLayout | undefined {
  const raw = fs.existsAndReadFile(layoutPath);
  if (raw === undefined) return undefined;
  try {
    return OfficeLayoutSchema.parse(JSON.parse(raw));
  } catch (err) {
    warnings.push(
      `existing ${layoutPath} is invalid and will be ignored for custom merge: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export interface RunImportResult {
  exitCode: number;
}

/**
 * import コマンド本体。graceful degradation（要件 §10）: 生成結果が 0 部署、または
 * 最終スキーマ検証に失敗した場合は出力ファイルを一切書き換えず（既存出力は mtime ごと
 * 不変）、理由を表示して非 0 終了する。
 */
export function runImport(flags: ImportFlags, deps: CliDeps): RunImportResult {
  const resolved = resolveRepos(flags, deps);
  if ("error" in resolved) {
    deps.error(resolved.error);
    return { exitCode: 1 };
  }

  const outDir = resolveOutDir(flags, deps);
  const layoutPath = join(outDir, "office-layout.json");
  const charactersPath = join(outDir, "characters.json");
  const attributionPath = join(outDir, "attribution.json");

  const warnings: string[] = [];
  const orgInputs: OrgMastersInput[] = [];
  const attributionRepos: AttributionRepoInput[] = [];

  for (const repoRoot of resolved.repos) {
    const { orgIds, activeOrgId } = discoverOrgs(repoRoot, deps.fs);
    if (orgIds.length === 0) {
      warnings.push(`repo "${repoRoot}": no organizations found under .companies/`);
      continue;
    }

    const attributionOrgs: AttributionOrgInput[] = [];
    for (const orgId of orgIds) {
      const masters = readOrgMasters(repoRoot, orgId, deps.fs);
      orgInputs.push(masters);

      const deptResult = masters.departmentsMd !== undefined ? parseDepartments(masters.departmentsMd) : { departments: [], errors: [] };
      const roleResult = masters.rolesMd !== undefined ? parseRoles(masters.rolesMd) : { roles: [], errors: [] };
      attributionOrgs.push({
        orgId,
        deptIds: deptResult.departments.map((d) => d.id),
        roles: roleResult.roles.map((r) => ({ id: r.id, dept: r.dept })),
      });
    }
    attributionRepos.push({ repoRoot, activeOrgId, orgs: attributionOrgs });
  }

  const existingLayout = loadExistingLayout(deps.fs, layoutPath, warnings);

  const importResult = importOrganizations(orgInputs, existingLayout);
  warnings.push(...importResult.warnings);

  const { index: attributionIndex, warnings: attrWarnings } = buildAttributionIndex({ repos: attributionRepos });
  warnings.push(...attrWarnings);

  for (const warning of warnings) {
    deps.error(`warning: ${warning}`);
  }

  if (importResult.layout.floors.length === 0) {
    deps.error(
      `import failed: no organizations produced a valid layout (0 departments across all sources). existing output under "${outDir}" left untouched.`,
    );
    return { exitCode: 1 };
  }

  if (flags.dryRun) {
    deps.log(
      `dry-run: would write office-layout.json / characters.json / attribution.json to ${outDir} (${importResult.layout.floors.length} floor(s), ${importResult.characters.length} character(s))`,
    );
    return { exitCode: 0 };
  }

  let validatedLayout: OfficeLayout;
  let validatedCharacters: Character[];
  let validatedAttribution: ReturnType<typeof AttributionIndexSchema.parse>;
  try {
    validatedLayout = OfficeLayoutSchema.parse(importResult.layout);
    validatedCharacters = z.array(CharacterSchema).parse(importResult.characters);
    validatedAttribution = AttributionIndexSchema.parse(attributionIndex);
  } catch (err) {
    deps.error(
      `import failed: generated data failed schema validation, existing output under "${outDir}" left untouched: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: 1 };
  }

  writeFileAtomic(deps.fs, layoutPath, serializeJson(validatedLayout));
  writeFileAtomic(deps.fs, charactersPath, serializeJson(validatedCharacters));
  writeFileAtomic(deps.fs, attributionPath, serializeJson(validatedAttribution));

  deps.log(
    `imported ${importResult.layout.floors.length} floor(s), ${importResult.characters.length} character(s) into ${outDir}`,
  );
  return { exitCode: 0 };
}

export function runCli(argv: string[], deps: CliDeps = defaultDeps): number {
  const { command, flags } = parseArgs(argv);

  if (flags.help || !command) {
    deps.log(HELP_TEXT);
    return 0;
  }

  switch (command) {
    case "import":
      return runImport(flags, deps).exitCode;
    default:
      deps.error(`unknown command: ${command}`);
      deps.log(HELP_TEXT);
      return 1;
  }
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  process.exitCode = runCli(process.argv.slice(2));
}
