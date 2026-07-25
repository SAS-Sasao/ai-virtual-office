import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// AC-7 の機械判定（M1-4b 設計メモ）:
//   1. ナレーションバー・バッジ相当のコンポーネントに onClick 等のイベント
//      ハンドラが 1 つも無いこと（可視化のみ・操作系ボタンを置かないスコープ判断）
//   2. UI コンポーネント群に、既存の GET /api/layout・EventSource /api/stream
//      以外のミューテーション送信（fetch/POST 等）が 0 件であること
// ラベル文字列の grep ではなく、ソースファイルの構造（正規表現による静的検査）で
// 判定する。実装ファイルを直接 fs で読み、実際に存在するソースを検証する
// （メモが指す名前が今も実在するかを確認したうえでの検査 — memory 節の方針）。

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const COMPONENTS_DIR = join(APP_DIR, "components");

function readSource(relativePath: string): string {
  return readFileSync(join(APP_DIR, relativePath), "utf-8");
}

function listComponentFiles(): string[] {
  return readdirSync(COMPONENTS_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .sort();
}

/**
 * ネイティブ DOM 要素に付ける React のイベントハンドラ props（`onClick` 等）を
 * 検出する。`onSelect={onSelectFloor}` のように**子コンポーネントへコールバックを
 * 渡すだけの custom prop**（実際の DOM イベント購読は子側の責務）は誤検出しない
 * よう、既知の DOM イベント名のみを許可リストとして走査する（AC-7 の「onClick 等」
 * を機械判定可能な範囲へ具体化したもの）。
 */
const JSX_EVENT_HANDLER_PATTERN =
  /\bon(Click|DoubleClick|MouseDown|MouseUp|MouseEnter|MouseLeave|MouseMove|PointerDown|PointerUp|PointerMove|KeyDown|KeyUp|KeyPress|Change|Submit|Focus|Blur|ContextMenu|TouchStart|TouchEnd|Drag|Drop)\s*=\s*\{/;

describe("AC-7: ナレーションバー・バッジ相当のコンポーネントに操作ハンドラが無い", () => {
  // NarrationBar = 秘書ナレーションバー本体。Header = 許可待ちバッジを内包する
  // コンポーネント（フロア切替の onClick は子の FloorTabs.tsx に閉じ込めてあり、
  // Header.tsx 自体にはハンドラを持たせない設計）。
  const NO_HANDLER_COMPONENTS = ["NarrationBar.tsx", "Header.tsx"];

  it.each(NO_HANDLER_COMPONENTS)("%s has zero JSX event handler props", (file) => {
    const source = readSource(join("components", file));
    expect(source).not.toMatch(JSX_EVENT_HANDLER_PATTERN);
  });

  it("sanity: the JSX event handler pattern does actually detect a real onClick (guards against a vacuously-true regex)", () => {
    const source = readSource(join("components", "FloorTabs.tsx"));
    expect(source).toMatch(JSX_EVENT_HANDLER_PATTERN);
  });
});

describe("AC-7: UI コンポーネント群からのエージェント操作系ミューテーション送信が 0 件", () => {
  const FETCH_CALL_PATTERN = /fetch\(\s*["'`]([^"'`]+)["'`]/g;
  const EVENT_SOURCE_CALL_PATTERN = /new EventSource\(\s*["'`]([^"'`]+)["'`]/g;
  const ALLOWED_FETCH_TARGETS = new Set(["/api/layout"]);
  const ALLOWED_EVENT_SOURCE_TARGETS = new Set(["/api/stream"]);
  // 待ちパネルの「確認」= focus のみは操作系に該当しない（AC-7 の定義）。
  const MUTATION_METHOD_PATTERN = /method\s*:\s*["']\s*(POST|PUT|PATCH|DELETE)\s*["']/i;

  // page.tsx（サーバコンポーネント）はヘッダ表示専用の SSR シードを
  // `loadOfficeLayoutData` 経由でサーバ側に直接読みに行くため fetch/EventSource は
  // 持たない。実際の fetch("/api/layout") / EventSource("/api/stream") は
  // クライアント側の OfficeView.tsx に集約されている（M1-4b: page.tsx 分割）。
  function allUiSourceFiles(): { path: string; source: string }[] {
    const componentFiles = listComponentFiles().map((f) => join("components", f));
    return [...componentFiles, "page.tsx", "OfficeView.tsx"].map((relativePath) => ({
      path: relativePath,
      source: readSource(relativePath),
    }));
  }

  it("every fetch() target across components/ + page.tsx + OfficeView.tsx is the allow-listed GET /api/layout", () => {
    for (const { path, source } of allUiSourceFiles()) {
      for (const match of source.matchAll(FETCH_CALL_PATTERN)) {
        expect(ALLOWED_FETCH_TARGETS.has(match[1]), `unexpected fetch("${match[1]}") in ${path}`).toBe(true);
      }
    }
  });

  it("every EventSource target across components/ + page.tsx + OfficeView.tsx is the allow-listed /api/stream", () => {
    for (const { path, source } of allUiSourceFiles()) {
      for (const match of source.matchAll(EVENT_SOURCE_CALL_PATTERN)) {
        expect(ALLOWED_EVENT_SOURCE_TARGETS.has(match[1]), `unexpected new EventSource("${match[1]}") in ${path}`).toBe(true);
      }
    }
  });

  it("no component, page.tsx, or OfficeView.tsx issues a mutating HTTP method (POST/PUT/PATCH/DELETE)", () => {
    for (const { path, source } of allUiSourceFiles()) {
      expect(MUTATION_METHOD_PATTERN.test(source), `unexpected mutating HTTP method in ${path}`).toBe(false);
    }
  });

  it("sanity: OfficeView.tsx does contain the allow-listed fetch/EventSource calls (guards against a vacuously-true check)", () => {
    const source = readSource("OfficeView.tsx");
    expect(source).toMatch(/fetch\(\s*["'`]\/api\/layout["'`]/);
    expect(source).toMatch(/new EventSource\(\s*["'`]\/api\/stream["'`]/);
  });

  it("sanity: page.tsx (server component) has no fetch/EventSource of its own (SSR seed uses loadOfficeLayoutData directly)", () => {
    const source = readSource("page.tsx");
    expect(source).not.toMatch(FETCH_CALL_PATTERN);
    expect(source).not.toMatch(EVENT_SOURCE_CALL_PATTERN);
  });
});
