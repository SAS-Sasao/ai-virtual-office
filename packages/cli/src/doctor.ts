import { HOOKS_SPEC } from "./hooks-spec.js";
import { mergeHooks } from "./merge.js";
import { loadSettings } from "./fs-safety.js";
import type { ResolvedPaths } from "./paths.js";

const DEFAULT_PORT = 4100;
const DEFAULT_TIMEOUT_MS = 2000;

export type DoctorScope = "user" | "project" | "user-local" | "project-local";

export interface DoctorHooksStatus {
  scope: DoctorScope;
  path: string;
  exists: boolean;
  /** JSON パースに失敗した場合 true（ファイル自体は変更しない読み取り専用診断）。 */
  parseError: boolean;
  installedSlugs: string[];
  missingSlugs: string[];
  /** マーカー無しの同等 hook（重複送信の恐れ）を検出した slug（AC-11b 相当の警告）。 */
  duplicateSlugs: string[];
}

export interface RelayHealth {
  ok: boolean;
  version: string;
  testMode: boolean;
  pid: number;
  port: number;
  receivedCount: number;
  lastEventAt: number | null;
}

export interface DoctorRelayStatus {
  reachable: boolean;
  health?: RelayHealth;
  error?: string;
}

export type DoctorFatalReason = "hooks-not-installed" | "relay-unreachable";

export interface DoctorReport {
  hooks: DoctorHooksStatus[];
  relay: DoctorRelayStatus;
  /** user または project のいずれかのスコープで 8/8 揃っているか。 */
  hooksInstalled: boolean;
  /** Relay 疎通はあるが、イベントを一度も受信していない場合 true（警告のみ・exit code に影響しない）。 */
  eventReachedWarning: boolean;
  /** 致命的理由。空でなければ exitCode は 1（"hooks 未導入" と "Relay 不通" の2条件に限定）。 */
  fatalReasons: DoctorFatalReason[];
  exitCode: 0 | 1;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface RunDoctorOptions {
  /** 4 パス（DI 済み、env や実 fs のホームディレクトリを doctor が直接参照することはない）。 */
  paths: ResolvedPaths;
  /** Relay のポート（既定 4100）。 */
  port?: number;
  /** fetch の DI（既定はグローバル fetch）。テストの決定論性のため。 */
  fetchImpl?: FetchLike;
  /** GET /health のタイムアウト（既定 2000ms）。 */
  timeoutMs?: number;
}

function inspectScope(scope: DoctorScope, path: string, port: number): DoctorHooksStatus {
  let loaded;
  try {
    loaded = loadSettings(path);
  } catch {
    // 壊れた JSON: doctor はクラッシュせず parseError として報告する（読み取り専用診断）。
    return {
      scope,
      path,
      exists: true,
      parseError: true,
      installedSlugs: [],
      missingSlugs: HOOKS_SPEC.map((e) => e.slug),
      duplicateSlugs: [],
    };
  }

  if (!loaded.exists) {
    return {
      scope,
      path,
      exists: false,
      parseError: false,
      installedSlugs: [],
      missingSlugs: HOOKS_SPEC.map((e) => e.slug),
      duplicateSlugs: [],
    };
  }

  // mergeHooks は純粋関数（入力を破壊しない）なので、診断目的で「もし今 setup したら
  // どうなるか」を dry-run 的に呼び出して既存状態を分類できる。書き込みは一切行わない
  // ため副作用は無い（AC-13）。
  const dryRun = mergeHooks(loaded.parsed, HOOKS_SPEC, port);

  return {
    scope,
    path,
    exists: true,
    parseError: false,
    installedSlugs: dryRun.skippedIdempotentSlugs,
    missingSlugs: dryRun.addedSlugs,
    duplicateSlugs: dryRun.skippedDuplicateSlugs,
  };
}

async function fetchHealth(
  port: number,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DoctorRelayStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://localhost:${port}/health`, { signal: controller.signal });
    if (!res.ok) {
      return { reachable: false, error: `GET /health returned HTTP ${res.status}` };
    }
    const health = (await res.json()) as RelayHealth;
    return { reachable: true, health };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 診断 4 項目（hooks 導入状態 / Relay 疎通 / イベント到達 / 競合・重複検知）を実行する。
 * **致命（exitCode 1）は「hooks 未導入」「Relay 不通」の2条件のみ**。イベント未到達や
 * 重複検知は警告として報告するのみで exit code に影響しない（M1-2b 設計メモ rev.3、
 * 人間承認済み方針）。
 */
export async function runDoctor(options: RunDoctorOptions): Promise<DoctorReport> {
  const { paths, port = DEFAULT_PORT, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const hooks: DoctorHooksStatus[] = [
    inspectScope("user", paths.userSettingsPath, port),
    inspectScope("project", paths.projectSettingsPath, port),
    inspectScope("user-local", paths.userLocalSettingsPath, port),
    inspectScope("project-local", paths.projectLocalSettingsPath, port),
  ];

  const relay = await fetchHealth(port, fetchImpl, timeoutMs);

  const userScope = hooks.find((h) => h.scope === "user");
  const projectScope = hooks.find((h) => h.scope === "project");
  // 配線が実際に成立しているとみなす条件は「CLI 自身のマーカー付き(installedSlugs)」
  // だけでなく「マーカー無しの手書き hook が既に同じ URL を叩いている(duplicateSlugs)」
  // も含める。後者は setup からは「二重送信になるため追加しない」対象だが、
  // イベント自体は実際に届く配線として機能しているため、doctor が矛盾して
  // fail するのを防ぐ（Phase3 レビュー finding4: setup が「already up to date」
  // exit0 を返す一方で doctor が exit1 になる矛盾の解消）。
  const wiredCount = (scope?: DoctorHooksStatus) =>
    (scope?.installedSlugs.length ?? 0) + (scope?.duplicateSlugs.length ?? 0);
  const hooksInstalled =
    wiredCount(userScope) === HOOKS_SPEC.length || wiredCount(projectScope) === HOOKS_SPEC.length;

  const eventReachedWarning = relay.reachable && (relay.health?.lastEventAt ?? null) === null;

  const fatalReasons: DoctorFatalReason[] = [];
  if (!hooksInstalled) fatalReasons.push("hooks-not-installed");
  if (!relay.reachable) fatalReasons.push("relay-unreachable");

  return {
    hooks,
    relay,
    hooksInstalled,
    eventReachedWarning,
    fatalReasons,
    exitCode: fatalReasons.length > 0 ? 1 : 0,
  };
}
