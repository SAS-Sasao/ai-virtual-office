import { MARKER, buildCommand, buildTargetUrl, type HookSpecEntry } from "./hooks-spec.js";

interface RawHookEntry {
  command?: unknown;
  [key: string]: unknown;
}

interface RawHookGroup {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

export interface MergeResult {
  settings: unknown;
  /** 今回新たに追加した slug。 */
  addedSlugs: string[];
  /** 既に CLI 自身のマーカー付きエントリがあり、追加しなかった slug（冪等）。 */
  skippedIdempotentSlugs: string[];
  /**
   * 同一 slug への同一 URL を叩く既存 hook が見つかり、それが完全体マーカー
   * （`#ai-office:cli`）を持たない場合、二重送信を避けるため追加しなかった slug
   * （AC-11b。手書きの `#ai-office`（完全体ではない接頭辞のみ）も対象に含む。
   * Phase3 レビュー finding3: 接頭辞での除外は二重送信を再導入するため撤回した）。
   */
  skippedDuplicateSlugs: string[];
  /**
   * 既存値が期待される形（配列）でない壊れた/未知形状の設定を検出し、
   * 上書きを避けるためそのイベントへの追記をスキップした slug
   * （Phase3 レビュー finding1: 無警告での上書き削除の防止）。
   */
  skippedMalformedSlugs: string[];
}

export interface RemoveResult {
  settings: unknown;
  /** 除去した #ai-office:cli マーカー付きエントリの件数。 */
  removedCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 未定義と "undefined" 文字列相当を区別しつつ、matcher の同一視キーを作る。 */
function normalizeMatcher(matcher: unknown): string | undefined {
  return typeof matcher === "string" ? matcher : undefined;
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 既存の Claude Code hooks 設定に、CLI 管理下の観測 hooks（HOOKS_SPEC）を
 * 追記する純粋関数。既存の内容は一切壊さず、必要な分だけ追加する。
 *
 * 同一視ルール:
 * 1. イベント直下の値、またはマッチする既存グループの `hooks` が配列でない
 *    （壊れた/未知形状の）場合、そのイベントには一切触れず追記もしない
 *    （Phase3 レビュー finding1: 無警告で既存値を空配列に上書きしていたバグの修正）。
 * 2. 同一 slug への同一 URL を叩く既存 hook が見つかり、それが完全体マーカー
 *    （#ai-office:cli）を持たない場合、二重送信を避けるため追加しない
 *    （手書きの `#ai-office` も対象。Phase3 finding3）。
 * 3. 対象 event + matcher（undefined は undefined として区別）の「中身が入って
 *    いる」既存グループに、CLI 自身の #ai-office:cli マーカー付きで同一 URL の
 *    エントリが既にあれば追加しない（冪等）。
 * 4. 中身が入っている一致グループがあればそこに追記する。無ければ新規グループを
 *    作成する（一致するが**空の**既存グループには追記しない。追記してしまうと
 *    teardown 側がそのグループを「完全に CLI 由来」と誤認して丸ごと削除し、
 *    元々存在した空グループ自体を消してしまうため。Phase3 finding9）。
 */
export function mergeHooks(existing: unknown, spec: readonly HookSpecEntry[], port: number): MergeResult {
  const settings: Record<string, unknown> = isRecord(existing) ? deepClone(existing) : {};
  const hooksObj: Record<string, unknown> = isRecord(settings.hooks) ? (settings.hooks as Record<string, unknown>) : {};
  settings.hooks = hooksObj;

  const addedSlugs: string[] = [];
  const skippedIdempotentSlugs: string[] = [];
  const skippedDuplicateSlugs: string[] = [];
  const skippedMalformedSlugs: string[] = [];

  for (const entry of spec) {
    const groupsRaw = hooksObj[entry.event];

    if (groupsRaw !== undefined && !Array.isArray(groupsRaw)) {
      // 既存値が配列ではない。原状を一切変更せず、このイベントへの追記はスキップする。
      skippedMalformedSlugs.push(entry.slug);
      continue;
    }

    const groups: RawHookGroup[] = Array.isArray(groupsRaw) ? (groupsRaw as RawHookGroup[]) : [];
    if (groupsRaw === undefined) {
      // イベント自体が元々存在しなかった場合のみ、空配列を新設する（安全）。
      hooksObj[entry.event] = groups;
    }

    const url = buildTargetUrl(entry.slug, port);

    const hasUnmarkedDuplicate = groups.some(
      (g) =>
        Array.isArray(g.hooks) &&
        (g.hooks as RawHookEntry[]).some(
          (h) => typeof h?.command === "string" && h.command.includes(url) && !h.command.includes(MARKER),
        ),
    );
    if (hasUnmarkedDuplicate) {
      skippedDuplicateSlugs.push(entry.slug);
      continue;
    }

    const matcherKey = normalizeMatcher(entry.matcher);
    const matchingGroups = groups.filter((g) => normalizeMatcher(g.matcher) === matcherKey);

    const malformedGroup = matchingGroups.find((g) => g.hooks !== undefined && !Array.isArray(g.hooks));
    if (malformedGroup) {
      skippedMalformedSlugs.push(entry.slug);
      continue;
    }

    const targetGroup = matchingGroups.find((g) => Array.isArray(g.hooks) && g.hooks.length > 0);

    if (targetGroup) {
      const hooksArr = targetGroup.hooks as RawHookEntry[];

      const alreadyOurs = hooksArr.some(
        (h) => typeof h?.command === "string" && h.command.includes(MARKER) && h.command.includes(url),
      );
      if (alreadyOurs) {
        skippedIdempotentSlugs.push(entry.slug);
        continue;
      }

      hooksArr.push({ type: "command", command: buildCommand(entry.slug, port) });
      addedSlugs.push(entry.slug);
    } else {
      // 一致するグループが無い、または一致するが空のグループしか無い場合は
      // 新規グループを作る（既存の空グループには触れず、そのまま残す）。
      const newGroup: RawHookGroup =
        matcherKey !== undefined
          ? { matcher: matcherKey, hooks: [{ type: "command", command: buildCommand(entry.slug, port) }] }
          : { hooks: [{ type: "command", command: buildCommand(entry.slug, port) }] };
      groups.push(newGroup);
      addedSlugs.push(entry.slug);
    }
  }

  return { settings, addedSlugs, skippedIdempotentSlugs, skippedDuplicateSlugs, skippedMalformedSlugs };
}

/**
 * `#ai-office:cli` マーカー付きのエントリのみを除去する純粋関数。手書きの
 * `#ai-office`（マーカー無しの完全体では無いもの）や他ツールの hook は一切
 * 変更しない。除去の結果、空になったグループ・イベント配列・hooks オブジェクト
 * は「元から無かった場合のみ」畳んで削除する（= 実際に変更した箇所でのみ
 * 空チェックを行い、元々あった空構造には触れない）。
 */
export function removeHooks(existing: unknown): RemoveResult {
  const settings: Record<string, unknown> = isRecord(existing) ? deepClone(existing) : {};
  let removedCount = 0;

  if (!isRecord(settings.hooks)) {
    return { settings, removedCount };
  }
  const hooksObj = settings.hooks as Record<string, unknown>;

  for (const eventName of Object.keys(hooksObj)) {
    const groups = hooksObj[eventName];
    if (!Array.isArray(groups)) continue;

    let eventChanged = false;
    const nextGroups: RawHookGroup[] = [];

    for (const group of groups as RawHookGroup[]) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        nextGroups.push(group);
        continue;
      }

      const hooksArr = group.hooks as RawHookEntry[];
      const filtered = hooksArr.filter((h) => {
        const isOurs = typeof h?.command === "string" && h.command.includes(MARKER);
        if (isOurs) {
          removedCount += 1;
          eventChanged = true;
        }
        return !isOurs;
      });

      if (filtered.length === 0 && hooksArr.length !== filtered.length) {
        // このグループは CLI 由来のエントリのみで構成されていた
        // （除去の結果ゼロになった = 元々存在しなかったのと等価）ので畳んで削除する。
        continue;
      }
      nextGroups.push({ ...group, hooks: filtered });
    }

    if (eventChanged) {
      if (nextGroups.length === 0) {
        delete hooksObj[eventName];
      } else {
        hooksObj[eventName] = nextGroups;
      }
    }
  }

  // 実物の `~/.claude/settings.json` は hooks キー自体を持たない（model/
  // enabledPlugins/effortLevel/theme のみ）。mergeHooks は hooks キーが無ければ
  // 新設するため、そこから setup → teardown を round-trip すると、hooks キーを
  // 保持したままだと `"hooks": {}` が残置され AC-3 の deep-equal が崩れる。
  // そのため「今回の除去で実際に空になった」場合は hooks キーごと削除する。
  //
  // トレードオフ（Phase3 レビュー finding2 で承認済み）: 元々 `hooks: {}` を
  // 明示的に持っていたファイルでは、除去後にこのキーが消える（{} → キー無し）。
  // Claude Code は hooks 無し／空 hooks を等価に扱うため実害は無いと判断し許容する。
  if (removedCount > 0 && Object.keys(hooksObj).length === 0) {
    delete settings.hooks;
  }

  return { settings, removedCount };
}
