# ai-virtual-office ループエンジニアリング設計書

## `.claude` 構成詳細 — 検証 hooks / SKILL カタログ / E2E 自動化

| 項目 | 内容 |
|------|------|
| ドキュメント種別 | 設計書（`.claude` 構成の詳細設計） |
| バージョン | 0.2.0（§3.4 開発サイクル Skill / §4.1 office-qa 合格基準を追加、game パス表記を `apps/web/game/` に修正） |
| 作成日 | 2026-07-19 |
| 対象リポジトリ | 【ai-virtual-office】(https://github.com/SAS-Sasao/ai-virtual-office) |
| 上位ドキュメント | 【要件定義書 v0.2】(./requirements.md) §5.4 / 【設計ドキュメント】(./architecture-design.md) |
| 思想的ベース | 【Loop Engineering (Addy Osmani)】(https://addyosmani.com/blog/loop-engineering/) / 【スキル自動最適化とループエンジニアリング (LayerX)】(https://zenn.dev/layerx/articles/9f25ec86a31730) |
| ステータス | レビュー待ち |

---

## 1. 背景と設計原則

### 1.1 ループエンジニアリングの適用方針

2 記事から採用する原則:

| # | 原則 | 出典 | 本設計への反映 |
|---|---|---|---|
| P1 | ルールはプロンプト空間ではなく決定論的検証に置く | Osmani（Verification） | CLAUDE.md の規約を検証 hooks に機械化（§2） |
| P2 | 評価（検証信号）をスキル本文より先に作る | LayerX（"Create evaluations BEFORE writing extensive documentation"） | 全 SKILL に「ギャップ記録」欄を必須化（§3.2） |
| P3 | maker と checker を分離する | Osmani（Sub-agents） | 実装 4 Subagent + 検証専任 office-qa（§4） |
| P4 | 停止条件は機械的合否で表現する | Osmani（/goal） | office-verify を exit code で合否が出る script に（§3.1） |
| P5 | スキルの全面リライトは劣化を招く。差分編集のみ | LayerX（テキスト学習率） + cc-sier PR #251→#254 教訓 | SKILL.md 編集規律（§3.3） |
| P6 | 無人ループには人間の観測面が必須 | Osmani（"A loop running unattended is also a loop making mistakes unattended"） | ai-virtual-office 自体が観測面（要件定義 §1.1） |

### 1.2 hooks の 2 系統（最重要の区別）

要件定義 NFR-2 の「exit 2 禁止・Claude Code を一切ブロックしない」は**観測用 hooks（A 系統）だけに適用される**。本書で設計する検証用 hooks（B 系統）は真逆で、**規約違反やテスト失敗を検出したら意図的にブロックする**ことが存在意義である。

| | (A) 観測用 hooks | (B) 検証用 hooks（本書） |
|---|---|---|
| 配置先 | 観測対象プロジェクト（setup CLI で配布） | ai-virtual-office リポジトリ自身の `.claude/settings.json` |
| 目的 | オフィス可視化のイベント収集 | 開発ループの検証信号（損失関数） |
| 失敗時挙動 | 必ず握り潰す（`\|\| true`） | **exit 2 でブロックし、stderr を Claude にフィードバック** |
| NFR-2 適用 | される | されない（ブロックが仕様） |
| ロジック配置 | Relay 側（settings.json は curl 1 行） | `.claude/hooks/verify/*.sh`（settings.json は配線のみ） |

---

## 2. 検証 hooks 設計（settings.json）

### 2.1 settings.json（ai-virtual-office リポジトリ）

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(pnpm install)", "Bash(pnpm build:*)", "Bash(pnpm test:*)",
      "Bash(pnpm --filter *)", "Bash(pnpm exec playwright *)",
      "Bash(pnpm lint:*)", "Bash(pnpm typecheck:*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/verify/guard-game-react.sh" },
          { "type": "command", "command": ".claude/hooks/verify/typecheck-touched.sh" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/verify/gate-protocol-consumers.sh" },
          { "type": "command", "command": ".claude/hooks/verify/gate-test-weakening.sh" },
          { "type": "command", "command": ".claude/hooks/verify/gate-e2e-smoke.sh" }
        ]
      }
    ]
  }
}
```

- 観測用（dogfooding）hooks は `npx ai-office setup --project` が同じ settings.json にマーカー付きでマージする（要件定義 §5.1）。検証用と観測用が同居するが、管轄が異なる（検証用は手書き・Git 管理、観測用は setup CLI 管理）
- **PostToolUse = 即時勾配**（編集 1 回ごとの高速フィードバック、数秒以内）、**Stop = エポック終端ゲート**（応答完了前の重い検証、〜90 秒）という時間予算の 2 層構造

### 2.2 hook スクリプト仕様

共通契約: stdin に hook イベント JSON。**exit 0 = pass / exit 2 = block（stderr が Claude に読まれ、自己修正ループに入る）**。全 script は `set -euo pipefail`、エラー握り潰し禁止（cc-sier 教訓）。

#### verify/guard-game-react.sh — game/ React 非依存ガード【PostToolUse】

NFR-7「`game/` は React 非依存」の機械化。

```
1. stdin から .tool_input.file_path を取得（jq）
2. apps/web/game/ 配下でなければ exit 0
3. grep -nE "from ['\"](react|react-dom|next)" "$file_path"
4. ヒットしたら exit 2:
   "apps/web/game/ は React 非依存が規約（NFR-7）。該当 import を削除し、
    React 連携が必要なら apps/web 側のアダプタ層に置くこと。検出行: {行}"
```

実行時間 < 100ms。

#### verify/typecheck-touched.sh — 触ったパッケージの型検査【PostToolUse】

```
1. file_path が *.ts / *.tsx でなければ exit 0
2. file_path から所属 workspace パッケージを特定（最寄りの package.json）
3. pnpm --filter {pkg} exec tsc --noEmit --incremental
   （--incremental キャッシュで 2 回目以降を数秒に抑える）
4. エラー時 exit 2: tsc 出力の先頭 30 行を stderr へ
```

初回が遅い場合の逃げ道として `AI_OFFICE_SKIP_TYPECHECK=1` を許すが、CI では必ず全量 typecheck が走るため逃げ切れない構造にする。

#### verify/gate-protocol-consumers.sh — protocol 変更時の両系テスト【Stop】

CLAUDE.md 規約「protocol 変更時は relay/web 両テスト」の機械化。

```
1. stdin の .stop_hook_active が true なら exit 0（無限ループ防止。
   2 周目で未解決の場合は .claude/hooks/verify/last-failure.log に記録して通す）
2. git diff --name-only HEAD + git diff --name-only main...HEAD に
   packages/protocol/ が含まれなければ exit 0
3. pnpm --filter @ai-office/relay test --run
4. pnpm --filter web test --run
5. いずれか fail なら exit 2: vitest の失敗サマリーを stderr へ
```

#### verify/gate-test-weakening.sh — テスト弱体化ガード【Stop】

「AI がテストを弱めて通す」対策（E2E 自動化の既知リスク、§5.4）。

```
1. stop_hook_active ガード（同上）
2. git diff -U0 main...HEAD -- '**/*.spec.ts' '**/*.test.ts' を走査
3. 以下のパターンを検出:
   - 追加行に .skip( / .only( / test.fixme
   - 削除行に expect( があり、対応する追加行に expect( がない（assertion 純減）
4. 検出時 exit 2: "テストの skip 追加 / assertion 削除を検出。意図的な場合は
   diff 概要と理由を応答に明記し、office-qa のレビューを要求すること"
```

機械では意図の善悪を判定できないため、**ブロックして理由の明示を強制する**（判定は人間と office-qa に残す = Osmani の P6）。

#### verify/gate-e2e-smoke.sh — E2E スモークゲート【Stop】

```
1. stop_hook_active ガード（同上）
2. apps/web/（game/ 含む）に diff がなければ exit 0
3. pnpm --filter web e2e:smoke（@smoke タグのみ、時間予算 60 秒、§5.2）
4. fail なら exit 2: playwright の失敗テスト名 + エラー 1 行要約を stderr へ
```

### 2.3 導入時期

| hook | 導入時期 | 理由 |
|---|---|---|
| guard-game-react | **M0 着手前** | 安価・即効。モジュール境界の劣化は初日から始まる |
| typecheck-touched | **M0 着手前** | 同上 |
| gate-protocol-consumers | protocol パッケージ初版と同時 | 対象が存在してから |
| gate-test-weakening | E2E 初版と同時 | 同上 |
| gate-e2e-smoke | M1（@smoke スイート成立後） | §5.2 |

---

## 3. SKILL カタログ

### 3.1 スキル一覧

```
.claude/skills/
├── office-verify/       ← 停止条件スキル【M0】
│   ├── SKILL.md
│   └── scripts/verify.sh
├── protocol-change/     ← 手順スキル【M1】
│   └── SKILL.md
├── e2e-authoring/       ← 規約スキル【M1】
│   └── SKILL.md
├── office-develop/      ← オーケストレータスキル【M0 骨格 / M1 完全版】
│   └── SKILL.md
└── office-release/      ← 手順スキル【M2 以降】
    └── SKILL.md
```

Skill は frontmatter の `name` がそのままスラッシュコマンドになる（`/office-verify` `/office-develop` 等）。明示呼び出し（`/`）とトリガー語による暗黙発動を併用する。

| skill | 種別 | 発動トリガー | 内容 |
|---|---|---|---|
| **office-verify** | 停止条件 | 「動作確認」「verify」、/goal の検証条件、office-qa から | `scripts/verify.sh` 一発で: build → Relay 起動（bg）→ fixture イベント注入 → Debug State API で描画状態 assert → **exit code で合否**。LLM の目視判断を挟まない |
| **protocol-change** | 手順 | 「イベント追加」「スキーマ変更」「protocol」 | Zod スキーマ編集 → 型再生成 → semver 判断（イベント追加 = minor / フィールド変更 = major）→ relay/web 両テスト → fixture 更新。gate-protocol-consumers hook と対になる「正しいやり方」の提示 |
| **e2e-authoring** | 規約 | 「E2E」「Playwright」「テスト書いて」 | AI が E2E spec を書く際の規約集（§5.3）。Debug State API の使い方、決定論性ルール、@smoke 選定基準、フレーク対策 |
| **office-develop** | オーケストレータ | `/office-develop`、「開発して」「機能追加」「開発サイクル」 | 設計 → レビュー → 実装（TDD）→ レビュー → E2E → 反映 の 6 フェーズ統合実行（§3.4）。各レビューゲートは office-qa の verdict JSON（§4.1）で合否判定し、**fail は前フェーズへループ** |
| **office-release** | 手順 | 「リリース」「デプロイ」 | ビルド → タグ →（将来）Vercel デプロイ。M2 まで着手しない |

### 3.2 評価シナリオ先行の規律（LayerX 規律）

SWE-Skills-Bench では評価なしで書かれたスキルの 49 本中 39 本が改善なし（平均 +1.2%）。これを避けるため、**全 SKILL.md は本文より先に「ギャップ記録」セクションを書く**:

```markdown
## ギャップ記録（このスキルが無いと起きる失敗）
<!-- 本文を書く前に、スキルなしで実際に失敗した具体例を 3 件記録する。
     3 件集まるまで本文は最小限（手順の骨子のみ）に留める -->
1. [2026-07-XX] {スキルなしで Claude が何をどう間違えたか}
2. ...
3. ...
```

- ギャップが 3 件集まらないうちは、スキルを「太らせない」（推測で網羅的な文書を書かない）
- 効果測定: スキル追加後、同種タスクで office-verify 通過率・hook ブロック回数が下がったかを task-log で確認

### 3.3 編集規律（テキスト学習率）

- **SKILL.md の全面リライト禁止。差分編集のみ**（cc-sier で全面リライトによる参照取りこぼし → PR #251→#253→#254 の 3 段階すり抜け修正が発生した実例。LayerX の「編集量制限」と同一の教訓）
- リライトが不可避な場合は cc-sier ルール（`grep` による必須セクション事前抽出 → 新旧照合）に従う
- 1,500〜2,000 語制約・references/ 外出しは cc-sier の skill-development ルールを踏襲

### 3.4 開発サイクル（/office-develop）

機能開発の標準パイプライン。各レビューゲートは office-qa の verdict JSON（§4.1）で合否判定し、**fail は前フェーズへループする**:

```
Phase 0 設計         maker が変更設計メモを起案（対象モジュール・受入基準・テスト方針・影響範囲）
Phase 1 設計レビュー   office-qa が §4.1 基準で採点
                      └ fail → findings を添えて Phase 0 へ（自動リトライ 1 回、2 回目 fail で人間へ）
Phase 2 実装（TDD）    受入基準から失敗するテストを先に書き（red）、実装で green にする。
                      PostToolUse 検証 hooks が即時勾配として並走
Phase 3 実装レビュー   office-qa が機械検証を実行した上で採点
                      └ fail → fix_suggestions を添えて maker に差し戻し Phase 2 へ（同上）
Phase 4 E2E          @smoke + 関連 spec 実行（e2e-authoring 規約）
                      └ fail → §5.3 ループ B の 3 分類で Phase 2 へ
Phase 5 反映         branch → PR 作成（verdict JSON を PR 本文に記載）→ auto-merge → 記録
```

- 立ち位置: cc-sier の 9 フェーズ統合実行フロー（L0/L1/L2 + auto-merge）の ai-virtual-office 版。L0 = 検証 hooks + scripts、L1 = maker のセルフチェック（TDD の red→green がその実体）、L2 = office-qa
- **M0 時点では Phase 4 を「E2E スイート未整備のため skip」とし、skip した事実を PR 本文に必ず記録する**（silent skip 禁止 = cc-sier「サイレント truncation 禁止」と同旨）。M1 で必須化
- 各ゲートのリトライ上限を超えた場合、PR は draft のまま人間のレビュー待ちとする（無人ループに判断を委ねない = 原則 P6）

---

## 4. Subagent 構成（maker-checker 分離）

要件定義 §5.4 の 4 Subagent は全員 maker（モジュール別実装者）。Osmani の maker-checker 分離に従い検証専任を 1 名追加する:

| agent | 役割 | model | tools | 責務 |
|---|---|---|---|---|
| game-engine-dev | maker | sonnet | Read, Write, Edit, Glob, Grep, Bash | apps/web/game 専任（既計画） |
| pipeline-dev | maker | sonnet | 同上 | relay/protocol/ingest（既計画） |
| ui-dev | maker | sonnet | 同上 | apps/web の React シェル（既計画） |
| org-adapter-dev | maker | sonnet | 同上 | cc-sier-adapter（既計画） |
| **office-qa**【追加】 | **checker** | **opus** | Read, Glob, Grep, Bash（**Write/Edit なし**） | office-verify 実行、実装 diff の敵対的レビュー、E2E spec のレビュー（特に assertion 削除・skip の妥当性判断）、フレークテストの原因分類 |

- office-qa に Write/Edit を与えない = checker が自分で直して馴れ合いになることを構造的に防ぐ（修正は必ず maker に差し戻す）
- 検証に強いモデル（opus）、実装は sonnet — Osmani の「強いモデルは検証に割り当てる」に従う
- 探索用途は Claude Code 標準の Explore agent（read-only・高速）で足りるため新設しない

### 4.1 office-qa 合格基準（verdict JSON）

office-qa のレビューは自由記述ではなく、cc-sier の L2 独立レビュー設計を移植した **6 軸採点 + verdict JSON** で出力する。合格基準のない checker はノイズの多い損失関数となり自己修正ループが収束しない（LayerX の指摘する「検証信号の質」問題）ため、判定は必ず本節の形式に従う:

```json
{
  "s1_mechanical": 0.00,
  "s2_design": 0.00,
  "s3_test_integrity": 0.00,
  "s4_quality": 0.00,
  "s5_traceability": 0.00,
  "s6_security": 0.00,
  "composite": 0.00,
  "verdict": "pass|fail",
  "critical_triggered": false,
  "findings": [],
  "fix_suggestions": []
}
```

| 軸 | 内容 | 致命軸 |
|---|---|---|
| s1_mechanical | 機械検証通過。office-verify / 関連テスト / hooks を**実際に実行**し、その結果で採点する（感想で埋めない = LLM の主観を機械信号で錨止め） | ★ |
| s2_design | 設計準拠（protocol 唯一正本・`apps/web/game/` React 非依存・NFR-8 テスタビリティ・設計書との整合） | |
| s3_test_integrity | テスト妥当性（assertion 弱体化なし・受入基準とのトレースあり・決定論性ルール準拠） | ★ |
| s4_quality | 実装品質（可読性・エラー処理・スコープ遵守） | |
| s5_traceability | 要件・設計書との対応が説明可能か | |
| s6_security | 機微情報の取り扱い（NFR-4: プロンプト本文・ファイル内容をクラウドへ送らない） | ★ |

**判定ルール（cc-sier review-pattern と統一）**:

- 致命軸（★）のいずれかが < 0.5 → composite 強制 0.00、verdict = fail、critical_triggered = true
- それ以外は composite = 等重み平均、**≥ 0.85 で pass**
- **E2E spec レビュー特則**: assertion 削除・skip 追加を含む diff は、理由の明示 + 対応する受入基準の変更が示されない限り s3 = 0（即 fail）

**リトライポリシー**: fail → findings / fix_suggestions を maker に差し戻し → 自動修正 1 回 → 再採点 → それでも fail なら人間へエスカレーション（PR は auto-merge しない）。office-qa は Write/Edit を持たないため、checker が自分で直して pass にする経路は構造的に存在しない。

---

## 5. E2E テスト AI 自動化設計

### 5.1 前提課題と 3 つの設計決定

Canvas 2D 描画は DOM を持たないため、通常の Playwright セレクタ assert が効かない。ピクセル比較だけに頼ると AI が失敗原因を読めず、自動修復ループが成立しない。そこで:

#### 決定 1: Debug State API（状態ファースト検証）

ゲーム内部状態を検査用に公開する。**E2E はピクセルではなく状態を assert する**:

```typescript
// apps/web: dev / test ビルドのみ有効（production では未定義）
window.__OFFICE_DEBUG__ = {
  getState(): {
    characters: Array<{ id: string; role: string; dept: string;
      state: CharacterState;        // packages/protocol の型を共有
      x: number; y: number; sessionId: string | null }>;
    floors: Array<{ org: string; rooms: string[] }>;
    pendingNotifications: number;   // 待ちパネル件数
    clock: number;                  // ゲーム内 tick（決定論検証用）
  };
  waitForIdle(): Promise<void>;     // アニメーション完了待ち（sleep 不要化）
};
```

- 型は `packages/protocol` から共有し、スキーマ変更時は gate-protocol-consumers が E2E 側の破綻も検出する
- これは**テスタビリティ要件**であり後付け不可。game パッケージの状態機械設計に最初から組み込む（要件定義 v0.2 で NFR-8 として追加）

#### 決定 2: 決定論性（フレーク根絶を仕組みで）

- **fixture イベント注入**: Relay に test モード限定の `POST /test/inject` を設け、シード付き fixture（`fixtures/e2e/*.jsonl` — OfficeEvent 列）を注入。実セッション不要で任意のオフィス状態を再現
- **fast-mode**: `?e2e=1` クエリで tween 時間 0・固定 tick 進行。時間依存の `sleep` を全面禁止し、`waitForIdle()` で同期
- fixture は task-log リプレイ（FR-5）と同一フォーマット → **リプレイ機能のテストデータと E2E fixture が共通資産になる**

#### 決定 3: Playwright + 2 層検証

| 層 | 手段 | ブロック性 |
|---|---|---|
| 第 1 層（主） | Debug State API への状態 assert | ブロッキング（PR ゲート / Stop hook） |
| 第 2 層（従） | `toHaveScreenshot`（mask + maxDiffPixelRatio）による視覚回帰 | 非ブロッキングから開始（通知のみ）、安定後に PR ゲート昇格 |

trace は `on-first-retry` で常時取得（AI 修復ループの入力になる）。

### 5.2 テストスイート構成と実行タイミング

| スイート | タグ | 時間予算 | 実行タイミング |
|---|---|---|---|
| smoke | `@smoke` | 60 秒 | Stop hook（gate-e2e-smoke）+ PR の CI |
| full E2E | なし | 10 分 | nightly + main への merge 後 |
| visual | `@visual` | 5 分 | nightly（非ブロッキング開始） |

@smoke の選定基準（e2e-authoring スキルに記載）: M0/M1 受入基準の直訳のみ。①アプリ起動 ②fixture 注入でキャラが 1 秒以内に状態遷移 ③待ちパネルに Notification が出る — の 3 本から始める。

### 5.3 AI 自動化の 3 ループ

#### ループ A: spec 生成（受入基準 → テスト）

```
入力: 要件定義の FR / マイルストーン受入基準（例: M1「3 部署の間取りが生成され…」）
1. maker（ui-dev 等）が e2e-authoring スキル参照で spec を起案
2. office-qa が spec をレビュー（受入基準との対応・決定論性ルール準拠・@smoke 判定）
3. 実装前にテストが fail することを確認してから実装（TDD 順序）
```

#### ループ B: 失敗修復（fail → 分類 → 修正）

```
入力: playwright JSON レポート + trace.zip
1. AI が失敗を 3 分類: ①プロダクトバグ ②spec の腐敗（仕様変更への追従漏れ）③フレーク
2. ① → 該当モジュールの maker に修正委譲（テスト側は触らない）
   ② → spec 修正。ただし assertion 削除・skip を含む場合は gate-test-weakening が
       ブロックし、理由明示 + office-qa レビューを強制
   ③ → ループ C へ
3. 修正後 re-run、green で完了
```

#### ループ C: フレーク退治（検出 → 隔離 → 根治）

```
1. nightly が「retry で通ったテスト」を集計し flake-report.md に追記（状態ファイル）
2. 2 回連続でフレークしたテストに @quarantine タグ → PR ゲートから除外（放置はしない）
3. AI が trace を比較して原因特定（ほぼ全てが決定論性ルール違反 = sleep 使用・
   waitForIdle 漏れ・fixture 非シード）→ 根治 PR → タグ除去
```

### 5.4 既知リスクと対策

| リスク | 対策 |
|---|---|
| AI がテストを弱めて green にする | gate-test-weakening hook（§2.2）+ office-qa の Write/Edit 剥奪（§4） |
| ピクセル比較のフレーク地獄 | 視覚回帰を第 2 層・非ブロッキングから開始。状態 assert を主にする |
| Debug State API の本番流出 | production ビルドで tree-shake されることを unit テストで検証 |
| E2E が遅くなり Stop hook が耐えられない | @smoke 60 秒予算の厳守。超過したら full 側へ降格（nightly が拾う） |

### 5.5 CI 配置（GitHub Actions）

- **PR**: typecheck 全量 + unit + `@smoke`（必須チェック化 → auto-merge の前提）
- **nightly**: full E2E + visual + flake 集計 → 失敗時は AI 修復ループ B を claude-code-action で起動。修復 PR の完了判定には office-qa の verdict JSON（§4.1）を用い、pass 以外は auto-merge しない
- cc-sier nightly 運用の教訓をそのまま移植する: `max-turns` 60 以上 / job-level env / `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1"` / `set -euo pipefail` / oauth token は input parameter 渡し

---

## 6. 導入ロードマップ（マイルストーン対応）

| MS | 導入するもの |
|---|---|
| **M0 着手前** | guard-game-react / typecheck-touched hooks、office-verify 骨格（build + 起動確認のみ）、office-qa agent（§4.1 verdict JSON 込み）、office-develop 骨格（§3.4。Phase 4 は skip 記録運用）、settings.json permissions |
| **M0→M1** | Debug State API（状態機械と同時実装）、fixture 注入エンドポイント、gate-protocol-consumers、protocol-change スキル、@smoke 3 本 + gate-e2e-smoke、e2e-authoring スキル、gate-test-weakening、CI PR ゲート、office-develop 完全版（Phase 4 必須化） |
| **M1→M2** | full E2E、visual 第 2 層、nightly + ループ B/C 自動化、office-release スキル |
| **M2 以降** | 朝の triage automation（CI 失敗 + issues → worktree → 修正 PR）。検証信号が揃った後にのみ解禁 |

自動化（automation）を最後に置くのは意図的: 検証信号が無いまま無人ループを回すことが最大のアンチパターンであるため（原則 P6）。

---

## 7. 用語

| 用語 | 定義 |
|---|---|
| 検証 hooks（B 系統） | ai-virtual-office 開発リポジトリ自身に置く、規約・テストの機械検証 hook。exit 2 でブロックする |
| 観測 hooks（A 系統） | オフィス可視化用のイベント収集 hook。絶対にブロックしない（NFR-2） |
| Debug State API | dev/test ビルド限定でゲーム内部状態を公開する検査 API。E2E の主検証面 |
| fast-mode | `?e2e=1` でアニメーション時間を 0 化し決定論実行するモード |
| ギャップ記録 | SKILL.md 本文より先に書く「スキル不在時の実失敗 3 件」。評価シナリオ先行規律の実装 |
| テスト弱体化 | assertion 削除・skip 追加によって検証信号を劣化させる変更。hook で検出し理由明示を強制 |
| verdict JSON | office-qa が出力する 6 軸採点 + 合否の構造化出力（§4.1）。レビューゲートと CI の機械可読な判定根拠 |
| 開発サイクル（/office-develop） | 設計 → レビュー → 実装（TDD）→ レビュー → E2E → 反映 の 6 フェーズ（§3.4）。各レビューゲート fail で前フェーズへループ |
