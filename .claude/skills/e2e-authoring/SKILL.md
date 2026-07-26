---
name: e2e-authoring
description: >
  ai-virtual-office の E2E（@smoke）を書く・直すときの規約集（設計書 §5.3 ループ A）。
  「E2E」「@smoke」「Playwright」「spec を追加」「フレークを直す」と依頼されたとき、
  および office-develop Phase 4 で E2E を追記・修正するときに使用する。Debug State API・
  決定論ルール・@smoke 選定基準・フレーク対策を正とする。
---

## ギャップ記録（このスキルが無いと起きる失敗）

<!-- 本文を書く前に、スキルなしで実際に失敗した具体例を 3 件記録する。
     3 件集まるまで本文は最小限（規約の骨子のみ）に留める（設計書 §3.2）。
     E2E スイートは M1-5 で新設。実失敗はまだ 0 件。以後 E2E で fail/flake が
     起きたら日付付きで追記してから本文を足すこと（全面リライト禁止）。 -->

（実失敗 0 件。M1-5 で新設。3 件集まるまで本文は最小限に留める。）

## 規約の骨子（§5.3 ループ A）

### 決定論（sleep 禁止）

1. **固定待ち（`page.waitForTimeout` / sleep）を書かない**。到達は必ず条件待ちで表現する:
   `page.waitForFunction(() => __OFFICE_DEBUG__.getState() が期待を満たす)` か
   `expect(locator).toHaveCount(...)`（auto-retry）を使う。壁時計の秒数は assert に使わない。
2. **`window.__OFFICE_DEBUG__.waitForIdle()`** を歩行完了の同期点にする（walk/leave が 0 かつ
   未消化パス 0 になるまで解決）。注入直後の状態を読む前に挟む。
3. **fixture はシード固定**（`fixtures/e2e/*.jsonl`・seq/ts 固定）。ランダム値・`Date.now()` を
   spec に持ち込まない（状態機械も時刻を注入で受ける設計）。
4. 全 spec は **`?e2e=1`**（fast-mode）で開く。歩行アニメが 0 tick で完了し、注入 → 遷移が
   決定論的に到達する。

### Debug State API（NFR-8）の使い方

- `getState()`: `{ characters, floors, pendingNotifications, clock }` を返す。dev/test ビルド
  限定（production では tree-shake され `window.__OFFICE_DEBUG__` は未定義）。
- 起動確認は `getState().floors.length >= 1`、状態遷移は
  `characters.find(c => c.sessionId === sid)?.state`、待ちは `pendingNotifications` で assert する。
- UI（React 側）の検証は DOM セレクタで行う（例: WaitingPanel は「許可待ち」見出しの section）。
  ゲーム状態（キャラ位置・state）は DOM ではなく Debug State API で見る。

### 注入経路（実経路を通す）

- fixture は **test relay（`AI_OFFICE_TEST_MODE=1`・専用ポート）→ `/test/inject` →
  forward → web の `/api/ingest` → SSE → ブラウザ**で流す。web の `/api/ingest` を直叩き
  しない（実経路＝relay 正規化・順序防御・SSE を通す）。relay の forward 先は検証用 web に
  明示的に向ける（既定は dogfooding web を指すため本番を汚す）。

### 本番非破壊（dogfooding と分離）

- 検証用 web/relay は **専用ポート**（dogfooding の 3001/4100 を使わない）。web の DB は
  `:memory:`、layouts は空の一時ディレクトリ、distDir は専用（`.next-e2e`）。relay の seq 状態も
  一時ディレクトリへ隔離する。検証前後で `~/.ai-office/{events.db,layouts}` を汚さない。
- 実行方式は **`next dev`（非 production）**。`next build`+`next start` は Debug State API を
  tree-shake するため E2E に使わない。

### @smoke 選定基準

- **M0/M1 の受入基準の直訳のみ**を @smoke にする（起動する / 注入で状態遷移する / 待ちが出る）。
  網羅・分岐・視覚回帰は @smoke に入れない（視覚回帰＝第 2 層は M2）。
- @smoke 全体で **60 秒予算**・1 テスト 10 秒 timeout。タグは `@smoke`、実行は
  `pnpm --filter web e2e:smoke`（`playwright test --grep @smoke`）。

### フレーク対策

- fail 時は §5.3 ループ B の 3 分類（実装バグ / テスト脆弱 / 環境依存）で切り分ける。
- 脆弱の典型: 固定待ちに依存、SSE 到達前に読む、restore/live のどちらか一方だけを想定。
  → 条件待ち（`waitForFunction`）に置換し、注入 → 到達を Debug State API でポーリングする。
- 連続実行で再現性を確認する（`for i in 1..5; do e2e:smoke; done` が全 green）。
