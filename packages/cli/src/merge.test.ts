import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeHooks, removeHooks } from "./merge.js";
import { HOOKS_SPEC, MARKER } from "./hooks-spec.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// 本リポジトリ自身の .claude/settings.json を fixture として使う（人工的な整形の
// fixture で自己充足しないため。テスト方針 4）。
const REPO_ROOT = join(__dirname, "..", "..", "..");
const REAL_SETTINGS_FIXTURE: unknown = JSON.parse(
  readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf-8"),
);

const PORT = 4100;

describe("mergeHooks", () => {
  it("AC-1: 本リポジトリの実 settings.json に対し、既存が1件も欠けず、8件のマーカー付きエントリが追加される", () => {
    // 実 fixture の既存 curl は port 4100 を叩くマーカー #ai-office（手書き）付き。
    // 衝突検証（AC-11b）と切り分けるため、ここでは別ポートで検証する。
    const differentPort = 5000;
    const result = mergeHooks(REAL_SETTINGS_FIXTURE, HOOKS_SPEC, differentPort);

    expect(result.addedSlugs.sort()).toEqual(HOOKS_SPEC.map((e) => e.slug).sort());
    expect(result.skippedIdempotentSlugs).toEqual([]);
    expect(result.skippedDuplicateSlugs).toEqual([]);

    // 既存の非 ai-office フックが消えていないこと
    const settings = result.settings as { hooks: Record<string, unknown> };
    const postToolGroups = settings.hooks.PostToolUse as Array<{
      matcher?: string;
      hooks: Array<{ command: string }>;
    }>;
    const editWriteGroup = postToolGroups.find((g) => g.matcher === "Edit|Write");
    expect(editWriteGroup?.hooks).toHaveLength(2);
    expect(editWriteGroup?.hooks.some((h) => h.command.includes("guard-game-react.sh"))).toBe(true);
    expect(editWriteGroup?.hooks.some((h) => h.command.includes("typecheck-touched.sh"))).toBe(true);

    const stopGroups = settings.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopGroups.some((g) => g.hooks.some((h) => h.command.includes("gate-protocol-consumers.sh")))).toBe(
      true,
    );

    // 元の #ai-office（手書き、CLI のマーカーとは異なる）マーカー付きエントリも残る
    const original = REAL_SETTINGS_FIXTURE as { hooks: Record<string, unknown> };
    expect(JSON.stringify(original)).toContain("#ai-office");

    // 新規追加分はすべて #ai-office:cli マーカー付き
    const serialized = JSON.stringify(settings);
    const cliMarkerCount = serialized.split(MARKER).length - 1;
    expect(cliMarkerCount).toBe(8);
  });

  it("AC-2: 冪等（2回目の setup は0件追加、内容は1回目と一致）", () => {
    const differentPort = 5000;
    const first = mergeHooks(REAL_SETTINGS_FIXTURE, HOOKS_SPEC, differentPort);
    const second = mergeHooks(first.settings, HOOKS_SPEC, differentPort);

    expect(second.addedSlugs).toEqual([]);
    expect(second.skippedIdempotentSlugs.sort()).toEqual(HOOKS_SPEC.map((e) => e.slug).sort());
    expect(second.settings).toEqual(first.settings);
  });

  it("AC-11b: マーカー無しの同等 curl が既にある場合、同一 slug を二重に追加しない", () => {
    const fixture = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                // マーカーが一切無い手書き curl（アーキ設計 §6.1 相当）
                command: `curl -s -X POST http://localhost:${PORT}/hooks/session-start -H 'Content-Type: application/json' -d @- --max-time 2 || true`,
              },
            ],
          },
        ],
      },
    };

    const result = mergeHooks(fixture, HOOKS_SPEC, PORT);

    expect(result.skippedDuplicateSlugs).toContain("session-start");
    expect(result.addedSlugs).not.toContain("session-start");
    // 他の 7 件は通常どおり追加される
    expect(result.addedSlugs).toHaveLength(7);

    const settings = result.settings as { hooks: Record<string, unknown> };
    const sessionStartGroups = settings.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    // 元の1本のみで、CLI 分は追加されていない
    const allHooks = sessionStartGroups.flatMap((g) => g.hooks);
    expect(allHooks).toHaveLength(1);
  });

  it("Phase3 finding1: イベント直下が配列でない(壊れた/未知形状)場合、そのイベントには追記せず既存値をそのまま保存する", () => {
    const fixture = {
      hooks: {
        // 配列であるべき値が壊れて文字列になっているケース（実測で報告された形）
        PostToolUse: "my-precious-guard.sh",
      },
    };

    const result = mergeHooks(fixture, HOOKS_SPEC, PORT);

    expect(result.skippedMalformedSlugs).toContain("post-tool");
    expect(result.addedSlugs).not.toContain("post-tool");
    // 既存値は一切変更されず、無警告での上書き削除が起きない
    const settings = result.settings as { hooks: Record<string, unknown> };
    expect(settings.hooks.PostToolUse).toBe("my-precious-guard.sh");
    // 他の7件は通常どおり追加される
    expect(result.addedSlugs).toHaveLength(7);
  });

  it("Phase3 finding1: マッチする既存グループの hooks が配列でない場合も、そのイベントには追記せず既存値をそのまま保存する", () => {
    const fixture = {
      hooks: {
        PostToolUse: [{ matcher: "*", hooks: "other-tool.sh" }],
      },
    };

    const result = mergeHooks(fixture, HOOKS_SPEC, PORT);

    expect(result.skippedMalformedSlugs).toContain("post-tool");
    expect(result.addedSlugs).not.toContain("post-tool");
    const settings = result.settings as { hooks: Record<string, unknown> };
    expect(settings.hooks.PostToolUse).toEqual([{ matcher: "*", hooks: "other-tool.sh" }]);
  });

  it("Phase3 finding3: 本リポジトリ形状(手書き #ai-office・同一ポート)へ setup すると、二重送信を避けるため全8件が追加されない", () => {
    // finding3 の実測どおり同一ポート(4100)で本物形状の fixture に対して実行する。
    const result = mergeHooks(REAL_SETTINGS_FIXTURE, HOOKS_SPEC, PORT);

    expect(result.addedSlugs).toEqual([]);
    expect(result.skippedDuplicateSlugs.sort()).toEqual(HOOKS_SPEC.map((e) => e.slug).sort());

    // #ai-office:cli（完全体マーカー）は1件も追加されていない = 二重送信が起きない
    const serialized = JSON.stringify(result.settings);
    expect(serialized.split(MARKER).length - 1).toBe(0);
    // 元の手書き #ai-office 8件は変わらず存在する
    expect(serialized.split("#ai-office").length - 1).toBe(8);
  });

  it("Phase3 finding9: 一致するグループが既存で空の場合は追記せず、新規グループを別途作成する(元の空グループは維持)", () => {
    const fixture = {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [] }],
      },
    };

    const result = mergeHooks(fixture, HOOKS_SPEC, PORT);

    expect(result.addedSlugs).toContain("pre-tool");
    const settings = result.settings as { hooks: Record<string, unknown> };
    const preToolGroups = settings.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    // 元の空グループはそのまま残り、CLI 用の新規グループが別に追加される
    expect(preToolGroups).toHaveLength(2);
    const untouchedEmpty = preToolGroups.find((g) => g.hooks.length === 0);
    expect(untouchedEmpty).toEqual({ matcher: "*", hooks: [] });
    const ours = preToolGroups.find((g) => g.hooks.length > 0);
    expect(ours?.hooks[0].command).toContain(MARKER);
  });

  it("既存に何も無いイベントには新規グループを作成する", () => {
    const result = mergeHooks({}, HOOKS_SPEC, PORT);
    expect(result.addedSlugs.sort()).toEqual(HOOKS_SPEC.map((e) => e.slug).sort());

    const settings = result.settings as { hooks: Record<string, unknown> };
    const preToolGroups = settings.hooks.PreToolUse as Array<{ matcher?: string }>;
    expect(preToolGroups).toHaveLength(1);
    expect(preToolGroups[0].matcher).toBe("*");

    const sessionStartGroups = settings.hooks.SessionStart as Array<{ matcher?: string }>;
    expect(sessionStartGroups[0].matcher).toBeUndefined();
  });

  it("null/undefined/配列などの不正な existing でも例外を投げず空の hooks から出発する", () => {
    expect(() => mergeHooks(null, HOOKS_SPEC, PORT)).not.toThrow();
    expect(() => mergeHooks(undefined, HOOKS_SPEC, PORT)).not.toThrow();
    expect(() => mergeHooks([], HOOKS_SPEC, PORT)).not.toThrow();
    expect(() => mergeHooks("not an object", HOOKS_SPEC, PORT)).not.toThrow();
  });

  it("既存の permissions 等、hooks 以外のトップレベルキーは変更しない", () => {
    const fixture = { permissions: { allow: ["Bash(pnpm test:*)"] } };
    const result = mergeHooks(fixture, HOOKS_SPEC, PORT);
    const settings = result.settings as { permissions: unknown };
    expect(settings.permissions).toEqual({ allow: ["Bash(pnpm test:*)"] });
  });

  it("入力オブジェクトを破壊的変更しない（immutable）", () => {
    const fixture = { hooks: { SessionStart: [{ hooks: [] }] } };
    const before = JSON.stringify(fixture);
    mergeHooks(fixture, HOOKS_SPEC, PORT);
    expect(JSON.stringify(fixture)).toBe(before);
  });
});

describe("removeHooks", () => {
  it("AC-3: setup → teardown で JSON として元と deep equal（残骸なし）", () => {
    const differentPort = 5000;
    const afterSetup = mergeHooks(REAL_SETTINGS_FIXTURE, HOOKS_SPEC, differentPort);
    const afterTeardown = removeHooks(afterSetup.settings);

    expect(afterTeardown.removedCount).toBe(8);
    expect(afterTeardown.settings).toEqual(REAL_SETTINGS_FIXTURE);
  });

  it("AC-11: #ai-office（手書きマーカー）の8件は teardown で残る", () => {
    const result = removeHooks(REAL_SETTINGS_FIXTURE);
    expect(result.removedCount).toBe(0);
    expect(result.settings).toEqual(REAL_SETTINGS_FIXTURE);

    const serialized = JSON.stringify(result.settings);
    // 元の #ai-office マーカー付きエントリ8件がすべて残っている
    const markerCount = serialized.split("#ai-office").length - 1;
    expect(markerCount).toBe(8);
  });

  it("Phase3 finding2: CLI 由来のみが追加されたイベントは除去後にグループごと消え、hooks キー自体も畳んで削除する", () => {
    // 実物の ~/.claude/settings.json は hooks キー自体を持たない。mergeHooks は
    // hooks キーが無ければ新設するため、除去後に空オブジェクトのまま hooks キーを
    // 残すと "hooks": {} が残置され AC-3 の deep-equal が崩れる。除去の結果
    // hooks が空オブジェクトかつ実際に何かを除去した場合は、hooks キーごと畳んで
    // 削除する（トレードオフ: 元々 `hooks: {}` を明示的に持っていたファイルでは
    // このキーが消えるが、Claude Code は両者を等価に扱うため実害は無いとして許容。
    // Phase3 レビュー finding2 で承認済み）。
    const fixture = { hooks: {} };
    const afterSetup = mergeHooks(fixture, HOOKS_SPEC, PORT);
    const afterTeardown = removeHooks(afterSetup.settings);

    expect(afterTeardown.removedCount).toBe(8);
    expect(afterTeardown.settings).toEqual({});
  });

  it("Phase3 finding2: hooks キーが元から無い(実物の ~/.claude/settings.json 相当)場合、round-trip で hooks キーが増えない", () => {
    const fixture = {
      model: "opus[1m]",
      enabledPlugins: { "frontend-design@claude-plugins-official": true },
      effortLevel: "xhigh",
      theme: "dark",
    };
    const afterSetup = mergeHooks(fixture, HOOKS_SPEC, PORT);
    const afterTeardown = removeHooks(afterSetup.settings);

    expect(afterTeardown.removedCount).toBe(8);
    expect(afterTeardown.settings).toEqual(fixture);
    expect(Object.prototype.hasOwnProperty.call(afterTeardown.settings as object, "hooks")).toBe(false);
  });

  it("Phase3 finding9: 一致するグループが既存で空だった場合、setup → teardown の round-trip でその空グループ自体は保持される", () => {
    const fixture = {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [] }],
      },
    };
    const afterSetup = mergeHooks(fixture, HOOKS_SPEC, PORT);
    const afterTeardown = removeHooks(afterSetup.settings);

    expect(afterTeardown.settings).toEqual(fixture);
  });

  it("hooks キー自体が無い設定は変更せず返す", () => {
    const fixture = { permissions: { allow: [] } };
    const result = removeHooks(fixture);
    expect(result.removedCount).toBe(0);
    expect(result.settings).toEqual(fixture);
  });

  it("null/undefined/配列などの不正な existing でも例外を投げない", () => {
    expect(() => removeHooks(null)).not.toThrow();
    expect(() => removeHooks(undefined)).not.toThrow();
    expect(() => removeHooks([])).not.toThrow();
  });

  it("入力オブジェクトを破壊的変更しない（immutable）", () => {
    const fixture = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `x ${MARKER}` }] }] } };
    const before = JSON.stringify(fixture);
    removeHooks(fixture);
    expect(JSON.stringify(fixture)).toBe(before);
  });
});
