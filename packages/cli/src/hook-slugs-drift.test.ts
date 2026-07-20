import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { HOOKS_SPEC } from "./hooks-spec.js";

/**
 * `HOOK_EVENT_SLUGS = new Set([...])` ブロックの中身から、クォートされた
 * 文字列リテラルをすべて抜き出す。slug は将来的に大文字・数字・アンダー
 * スコアを含みうる（Phase3 レビュー finding6: `[a-z-]+` だと見逃す）ため、
 * クォート文字そのもの以外は何でも許容する `[^"']+` を使う。
 */
function extractQuotedStrings(setBody: string): Set<string> {
  return new Set([...setBody.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]));
}

describe("extractQuotedStrings（抽出ロジック単体）", () => {
  it("Phase3 finding6: 大文字・数字・アンダースコアを含む slug も見逃さない", () => {
    const body = `\n  "session-start",\n  "Pre_Tool2",\n  'SCREAMING-CASE',\n`;
    expect(extractQuotedStrings(body)).toEqual(new Set(["session-start", "Pre_Tool2", "SCREAMING-CASE"]));
  });

  it("旧正規表現 [a-z-]+ ではこれらを見逃していたことの確認（回帰の説明用）", () => {
    const body = `\n  "Pre_Tool2",\n  'SCREAMING-CASE',\n`;
    const oldPatternMatches = new Set([...body.matchAll(/["']([a-z-]+)["']/g)].map((m) => m[1]));
    // 旧パターンは大文字・数字・アンダースコアを含む部分でマッチが崩れる
    expect(oldPatternMatches).not.toEqual(new Set(["Pre_Tool2", "SCREAMING-CASE"]));
  });
});

// AC-11c: CLI の slug 一覧が packages/relay の HOOK_EVENT_SLUGS と完全一致することを
// devDependency（@ai-office/relay、workspace:*）経由で検証する。relay 本体のソースは
// 変更しない（別担当が並行作業中）ため、公開 API 化されていない内部定数を、ソース
// テキストを直接読んで抽出する形で照合する（ドリフト検知が目的であり、relay の
// リファクタは別スコープ）。
describe("HOOKS_SPEC slugs vs @ai-office/relay の HOOK_EVENT_SLUGS", () => {
  it("ドリフトしていない（slug の集合が完全一致）", () => {
    const require = createRequire(import.meta.url);
    const relayPackageJsonPath = require.resolve("@ai-office/relay/package.json");
    const relaySrcDir = join(dirname(relayPackageJsonPath), "src");
    const serverSource = readFileSync(join(relaySrcDir, "server.ts"), "utf-8");

    const match = serverSource.match(/HOOK_EVENT_SLUGS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(match).not.toBeNull();

    const relaySlugs = extractQuotedStrings(match?.[1] ?? "");
    expect(relaySlugs.size).toBeGreaterThan(0);

    const cliSlugs = new Set(HOOKS_SPEC.map((entry) => entry.slug));

    expect(cliSlugs).toEqual(relaySlugs);
  });
});
