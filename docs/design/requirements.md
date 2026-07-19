# AI Virtual Office 要件定義書 v0.2

## Claude Code エージェント可視化アプリ — CC-SIer 仮想組織ベース版

| 項目 | 内容 |
|------|------|
| ドキュメント種別 | 要件定義書 |
| バージョン | 0.2.0（ループエンジニアリング反映: §1.1-4 / §5.4 / NFR-8） |
| 作成日 | 2026-07-18 |
| 開発リポジトリ | `ai-virtual-office`（新規・独立リポジトリ。`/company-spawn` で切り出し） |
| ベースライン | [【設計ドキュメント 2026-07-17】](./architecture-design.md) / [【pixel-agents】](https://github.com/pixel-agents-hq/pixel-agents) / [【CC-SIer 要件定義 v0.3】](https://github.com/SAS-Sasao/cc-sier-organization/blob/main/docs/requirements.md) |
| ステータス | レビュー待ち |

---

## 1. プロジェクト概要

### 1.1 背景と目的

Claude Code による並列・自律的なエージェント作業は「今、誰が、何をしているか」が見えにくい。pixel-agents はローカルセッションをピクセルオフィスとして可視化する解を示したが、**組織の概念を持たない**（キャラは無所属・オフィスは手作業レイアウト）。

一方 CC-SIer は `masters/` によるマスタ駆動の仮想組織（部署・ロール・ワークフロー）を確立済みだが、その活動は task-log や dashboard.html という**帳票的な可視化**に留まる。

本プロジェクトは両者を接合し、**「CC-SIer の仮想組織が実際に働いているオフィス」を眺められる本格 Web アプリケーション**を構築する。

1. **組織定義駆動のオフィス生成** — 部屋・キャラ・座席を手作業ではなく CC-SIer マスタから生成する（本アプリ最大の差別化点）
2. **ライブ + リプレイの二面性** — ローカル Claude Code セッションのライブ可視化と、task-log からの過去活動リプレイ（GitHub Actions 上のエージェントも再生可能）
3. **`.claude` 設定を製品の一部として設計** — hooks・settings・agents の設定群は「アプリに観測能力を与える配線」であり、導入・更新・撤去までをアプリの提供物として扱う
4. **ループエンジニアリングの観測面** — 自律エージェントループの設計論（【Loop Engineering (Addy Osmani)】(https://addyosmani.com/blog/loop-engineering/)）は「無人で回るループは無人で間違え続ける」として人間の観測・トリアージ層を必須とする。本アプリのオフィスビュー + 待ちパネルはその観測面の実装であり、「可愛い可視化」ではなく**ループ運用の実用インフラ**として位置づける

### 1.2 スコープ

| 区分 | 内容 |
|------|------|
| **スコープ内** | オフィス描画（Canvas 2D）、イベントパイプライン（hooks → Relay → Store → UI）、CC-SIer 組織インポート、セッション帰属、リプレイ、`.claude` 設定の導入体験（setup CLI）、ローカル実行、Vercel デプロイ準備 |
| **スコープ外（v1 時点）** | オフィスからのエージェント操作（起動・停止・指示送信）、Claude Code 本体の改造、cc-sier 側リポジトリの仕様変更、課金・マルチテナント |

### 1.3 利用シーン

- **Phase 1（ローカル）**: 開発者自身が手元で常時表示し、並列セッション・サブエージェントの状態を把握する（pixel-agents の代替 + 組織文脈）
- **Phase 2（Vercel）**: チーム/対外にオフィスを公開し、「AI 仮想会社が働いている様子」をデモ・共有する

### 1.4 前提とする既存資産

| 資産 | 場所 | 本アプリでの扱い |
|---|---|---|
| 組織マスタ | `cc-sier-organization/.companies/{org}/masters/*.md` | インポート元（読み取りのみ） |
| task-log | `.companies/{org}/.task-log/*.md` | リプレイのイベントソース（読み取りのみ） |
| Subagent 定義 | `.claude/agents/*.md`（19 種） | キャラクター名・ロール判定の参照 |
| 設計ドキュメント | `docs/research/ai-virtual-office-design.md` | アーキテクチャの正本（本書 §6 は要約のみ） |

---

## 2. コンセプト: CC-SIer 理念の継承

CC-SIer の「会社をマスタで定義し、Skill/Subagent で運営する」理念を、そのまま**空間表現**に写像する。

### 2.1 概念マッピング（本アプリの世界観の正本）

| CC-SIer 概念 | ソース | オフィス表現 | 備考 |
|---|---|---|---|
| 組織（company） | `masters/organization.md` | **フロア** | 複数組織 = 複数フロア。エントランス看板に組織名 |
| 部署（department） | `masters/departments.md` | **部屋** | `active` のみ描画。`standby` はドア閉鎖・照明 OFF |
| ロール（role/Subagent） | `masters/roles.md` + `.claude/agents/*.md` | **常駐キャラクター + 専用デスク** | ロール 1:1 キャラ。model（opus/sonnet）をキャラの見た目差分に反映してよい |
| 秘書（secretary） | 同上 | **受付キャラ** | エントランス常駐。依頼受付 → 担当部署へ歩いて委譲する演出 |
| ワークフロー（workflow） | `masters/workflows.md` | **定型の動線演出** | wf-daily-digest 等は関与キャラの部屋間移動としてアニメ化 |
| Agent Teams / サブエージェント | 実行時イベント | **会議室の臨時キャラ** | spawn で出現・親とリンク線・Stop で退出 |
| トリガーワード | `masters/departments.md` | 部屋のツールチップ | ホバーで「この部屋が反応する言葉」を表示 |
| task-log | `.task-log/*.md` | **リプレイ素材** | タイムスタンプ付き委譲ログ → イベント列 |
| 3 層レビュー（L0/L1/L2） | task-log の l0/l1/l2 | **検品室の演出**（P2） | L2 レビュアーが成果物を検品、fail で差し戻し演出 |

### 2.2 設計原則（cc-sier から継承するもの）

1. **マスタ駆動**: オフィスの構造情報は手入力せず、マスタ → JSON 生成の一方向とする（レイアウトエディタでの手調整は `custom` フラグで共存）
2. **本体無改造**: Claude Code にも cc-sier リポジトリにも改造を要求しない（読み取り + hooks 追記のみ）
3. **プログレッシブ・ディスクロージャ**: アプリ本体は CC-SIer を知らない。`cc-sier-adapter` が境界で正規化 JSON に変換する（他の組織形式にも将来対応可能）
4. **観測データの尊重**: cc-sier が蓄積する task-log / session-summaries の形式を正とし、アプリ側に都合よく変えない

---

## 3. 機能要件

優先度: **P1** = M0-M1（ローカル α に必須）/ **P2** = M2 / **P3** = M3 以降

### FR-1 オフィス描画【P1】

- Canvas 2D によるピクセルアートオフィスのレンダリング（整数ズーム、パン）
- フロア（組織）> 部屋（部署）> デスク（ロール）の 3 階層構造
- キャラクター状態機械: `idle / walk / type / read / terminal / browsing / thinking / waiting / done / leave`
- BFS 経路探索によるキャラ移動（部屋間の委譲演出）
- 60fps 維持（キャラ 30 体・イベント 10 件/秒で劣化しないこと）

### FR-2 ライブ可視化（イベントパイプライン）【P1】

- Claude Code hooks（§5.2）からのイベントを受信し、**1 秒以内**にキャラ状態へ反映
- ツール → 状態マッピング（設計ドキュメント §7 の表を正とする）
- 並列セッションを別キャラとして同時表示。`PreToolUse(Task)` でサブエージェント spawn、`SubagentStop` で退出
- 入力待ち・許可待ち（Notification）は**吹き出し + 一覧パネル**で強調（pixel-agents の弱点改善）
- セッション終了（Stop / SessionEnd）後のキャラ残留を防ぐ（タイムアウト退社処理。pixel-agents 既知バグの解消）

### FR-3 CC-SIer 組織インポート【P1】

- `cc-sier-adapter` CLI が `masters/organization.md / departments.md / roles.md` を解析し、`office-layout.json` + `characters.json` を生成
- 再実行は冪等。手動カスタム分（`custom: true`）は上書きしない
- マルチ組織（3 組織）をフロア切替 UI で表示
- マスタに無い形式（他ユーザーの組織）でも、**汎用スキーマの JSON を手書きすれば動く**こと（アプリ本体の CC-SIer 非依存）

### FR-4 セッションの部署帰属【P1】

hooks イベントの `cwd` / ブランチ名 / subagent_type から「どの部署の仕事か」を推定し、キャラを該当部屋で作業させる:

1. `cwd` が登録済み組織リポジトリ → `.companies/.active` で組織特定
2. ブランチ名 `{org}/{type}/...` プレフィックス → 組織・作業種別
3. `Task` の subagent_type（例: tech-researcher）→ `roles.md` 経由で所属部署
4. 判定不能 → 受付（秘書室）に帰属

### FR-5 リプレイ【P2】

- `import-tasklog.ts` が task-log のエージェント作業ログ（`[時刻] secretary → general-purpose-tech 委譲`）をイベント列に変換
- 時刻順再生（速度 1x/10x/60x）、シークバー付き
- GitHub Actions 上の daily-digest 部隊（ローカル hooks で捕捉不能）の朝の活動を再生できることが受入条件
- ライブとリプレイは同一のイベント消費インターフェース（`OfficeEvent[]` ストリーム）

### FR-6 レイアウトエディタ【P2】

- 床・壁・家具のドラッグ配置、JSON 保存
- マスタ生成領域は「再インポートで戻る」旨を UI 表示（`custom` フラグ領域のみ永続）

### FR-7 通知・音【P2】

- エージェント完了・許可待ちのチャイム音（ON/OFF 可）
- ブラウザタブのバッジ表示（待ち件数）

### FR-8 公開モード【P3】

- Vercel デプロイ + 認証付き ingest + 公開閲覧ページ
- ライブ転送（Relay cloud-forward）とリプレイ公開（デモ用）の 2 形態

---

## 4. 非機能要件

| # | 分類 | 要件 |
|---|---|---|
| NFR-1 | 性能 | イベント受信 → 画面反映 1 秒以内 / 描画 60fps（キャラ 30 体） |
| NFR-2 | 信頼性 | hooks の curl は `--max-time 2 \|\| true` とし、**Claude Code の動作を一切ブロックしない**（exit 2 禁止）。Relay 停止中も Claude Code は正常動作 |
| NFR-3 | 復元性 | イベント欠落があっても状態機械が最終状態に収束する（イベントソーシングではなく「最新状態優先」の設計） |
| NFR-4 | セキュリティ | ingest エンドポイントは Phase 2 で Bearer トークン必須。イベントに含まれる `tool_input` は**プロンプト本文・ファイル内容を Relay で落とし**、ツール名・ファイルパス程度に絞る（機微情報をクラウドへ送らない） |
| NFR-5 | 可搬性 | ローカルは `pnpm dev` + `npx ai-office-relay` の 2 プロセスで完結。Node 20+ / 主要ブラウザ最新版 |
| NFR-6 | ライセンス | ピクセル素材は CC0 / CC-BY 系のみ。出典を README + 画面フッターに表記 |
| NFR-7 | 保守性 | `game/` は React 非依存、`protocol` が唯一のスキーマ正本（Zod）。状態機械・正規化はユニットテスト対象 |
| NFR-8 | テスタビリティ | Canvas 描画の内部状態を dev/test ビルド限定の **Debug State API**（`window.__OFFICE_DEBUG__`）で公開し、E2E は「ピクセルではなく状態」を検証可能とする。Relay は test モード限定の fixture イベント注入エンドポイントを持ち、`?e2e=1` の fast-mode でアニメーションを決定論実行できる（後付け不可のため状態機械設計に最初から組み込む。詳細:【ループエンジニアリング設計書】(./loop-engineering-design.md) §5） |

---

## 5. `.claude` 設定設計（本アプリの肝）

`.claude` 設定は 2 つの文脈で登場する。**(A) 観測対象プロジェクトに配る設定**（アプリの入力を作る配線）と、**(B) ai-virtual-office リポジトリ自身の開発用設定**（cc-sier 流の開発運営）。

### 5.1 (A) 観測対象側: 設定の導入・撤去をアプリの機能にする

手書きコピペではなく、**setup CLI を提供**する:

```bash
npx ai-office setup            # ~/.claude/settings.json に hooks を安全にマージ
npx ai-office setup --project  # カレントの .claude/settings.json に限定導入
npx ai-office setup --dry-run  # 差分表示のみ
npx ai-office teardown         # 導入した hooks だけを除去（他の hooks は温存）
npx ai-office doctor           # 導入状態・Relay 疎通・イベント到達を診断
```

要件:

- **マージ安全性**: 既存 hooks（cc-sier は 15 本運用中）を壊さず追記。自アプリ由来の hook にはコマンド文字列にマーカー（例: `#ai-office`）を含め、teardown はマーカーのみ除去
- **設定階層の選択**: user（`~/.claude/settings.json`、全プロジェクト観測）と project（`.claude/settings.json`、リポジトリ限定）を選択可能。既定は user
- **導入の可逆性**: teardown 後に痕跡ゼロ

### 5.2 (A) hooks イベント設計

| hook | 用途 | オフィス上の意味 |
|---|---|---|
| SessionStart | セッション開始 + `cwd` 取得 | キャラ出社（帰属推定 FR-4 の入力） |
| UserPromptSubmit | 依頼受付 | 受付キャラが担当部屋へ移動する演出のトリガ |
| PreToolUse (`matcher: *`) | ツール実行開始 + tool_name | 状態遷移（type/read/terminal/browsing） |
| PreToolUse (`matcher: Task`) | サブエージェント生成 | 会議室に臨時キャラ spawn + 親リンク |
| PostToolUse | ツール完了 | 状態解除（連続途絶で thinking へ） |
| Notification | 許可待ち・入力待ち | 吹き出し + 待ちパネル + チャイム |
| Stop | 応答完了 | done → タイムアウトで退社 |
| SubagentStop | サブエージェント終了 | 臨時キャラ退出 |
| SessionEnd | セッション終了 | 即時退社（Idle 残留防止の確定信号） |

実装規約（全 hook 共通）: `curl -s -X POST http://localhost:4100/hooks/{event} -d @- --max-time 2 || true`。stdin JSON は Relay で正規化し、**settings.json 側にロジックを書かない**。

### 5.3 (A) 組織データソースの設定

```jsonc
// ~/.ai-office/config.json（Relay / adapter が参照）
{
  "organizations": [
    { "repo": "/home/toyoki05/cc-sier-organization", "type": "cc-sier" }
  ],
  "forward": { "url": null, "token": null }   // Phase 2 で Vercel URL + token
}
```

- adapter は `type: "cc-sier"` の場合に `.companies/*/masters/` を走査してレイアウト生成、`.companies/*/.task-log/` をリプレイソースとして登録
- 組織リポジトリのパス登録により FR-4 の `cwd` 帰属が有効化される

### 5.4 (B) ai-virtual-office リポジトリ自身の `.claude` 構成（ループエンジニアリング準拠）

新リポジトリは cc-sier の開発理念（CLAUDE.md ルール + 専門 Subagent + 品質ゲート）に加え、**ループエンジニアリングの原則**（検証信号ファースト・maker-checker 分離・評価シナリオ先行のスキル運用）で運営する。詳細設計は【ループエンジニアリング設計書】(./loop-engineering-design.md) を正とし、本節は要件レベルの構成のみ示す:

```
ai-virtual-office/
└── .claude/
    ├── settings.json          ← 開発用 permissions + 検証 hooks（下表）+ 自アプリの観測 hooks を dogfooding 導入
    ├── hooks/verify/          ← 検証 hooks スクリプト（規約の機械化。exit 2 でブロック）
    ├── agents/
    │   ├── game-engine-dev.md      ← maker: Canvas/状態機械/経路探索（game/ 配下専任）
    │   ├── pipeline-dev.md         ← maker: Relay/protocol/ingest 担当
    │   ├── ui-dev.md               ← maker: React シェル/画面 担当
    │   ├── org-adapter-dev.md      ← maker: cc-sier-adapter/インポータ 担当
    │   └── office-qa.md            ← checker: 検証専任（opus、Write/Edit なし。E2E レビュー・敵対的レビュー）
    └── skills/
        ├── office-verify/          ← 停止条件スキル: scripts/verify.sh が exit code で合否（/goal の検証条件）
        ├── protocol-change/        ← 手順スキル: スキーマ変更 → 型再生成 → relay/web 両テスト
        ├── e2e-authoring/          ← 規約スキル: AI が Playwright E2E を書くためのルール集
        └── office-release/         ← 手順スキル: ビルド・タグ・（将来）Vercel デプロイ
```

**hooks は 2 系統に分離する（本節の核心）**:

| 系統 | 目的 | 失敗時挙動 | NFR-2 適用 |
|---|---|---|---|
| (A) 観測 hooks | オフィス可視化のイベント収集（§5.1-5.2） | 必ず握り潰す（`\|\| true`） | される |
| (B) 検証 hooks | 開発規約・テストの機械検証（損失関数） | **exit 2 でブロックし Claude に自己修正させる** | されない（ブロックが仕様） |

検証 hooks の初期セット: ① `game/` React 非依存ガード（PostToolUse）② 触ったパッケージの typecheck（PostToolUse）③ protocol 変更時の relay/web 両テストゲート（Stop）④ テスト弱体化ガード（Stop）⑤ E2E スモークゲート（Stop）。CLAUDE.md に書く規約は可能な限りこの検証 hooks に機械化し、文章規約はその補足とする。

- **dogfooding**: 本リポジトリでの Claude Code 開発作業自体を自アプリで観測する（開発中の最良のテストデータになる）
- **スキル運用規律**: 全 SKILL.md は本文より先に「ギャップ記録（スキル不在時の実失敗 3 件）」を書く。全面リライト禁止・差分編集のみ
- **E2E 自動化**: Playwright + Debug State API（NFR-8）による状態ファースト検証。spec 生成 / 失敗修復 / フレーク退治の 3 ループを AI が担う（設計書 §5）
- Subagent の分割は maker 4 領域（モジュール境界と一致）+ checker 1（maker-checker 分離）

---

## 6. アーキテクチャ要件（設計ドキュメントの要約）

詳細は [【設計ドキュメント】](./architecture-design.md) を正とする。本書では要件レベルの制約のみ再掲:

- **Relay 分離**: hooks 受信はローカル常駐 Relay。Phase 2 でも「Relay → クラウド転送」の形を維持（AR-1）
- **技術スタック**: TypeScript / Next.js 15 / 素の Canvas 2D / Zod / Drizzle / pnpm monorepo（AR-2）
- **リアルタイム**: ローカル = SSE、Vercel = Supabase Realtime 等のマネージド（AR-3。Vercel に常駐 WebSocket を置かない）
- **リポジトリ構成**: `apps/web` + `packages/{protocol, relay, cc-sier-adapter}`（AR-4）
- **ライブ/リプレイ同一インターフェース**: 消費側は `OfficeEvent` ストリームのみを見る（AR-5）

---

## 7. データ要件

| データ | スキーマ正本 | 保存先 | 備考 |
|---|---|---|---|
| OfficeEvent | `packages/protocol/src/events.ts`（Zod） | SQLite（ローカル）/ Postgres（Vercel） | 正規化済みイベント。`session_id / org / dept / role / state / ts / seq` |
| OfficeLayout | `packages/protocol/src/layout.ts` | JSON ファイル（`~/.ai-office/layouts/`） | adapter 生成 + `custom` フラグ |
| Character | 同上 | 同上 | role ↔ キャラ ↔ スプライトの対応 |
| 保持期間 | — | イベントはローカル 30 日ローテーション | リプレイ用に日単位エクスポート可 |

**機微情報の扱い（NFR-4 の具体化）**: `tool_input` のうち保存するのは `tool_name` / `file_path`（ベース名まで）/ `subagent_type` のみ。プロンプト本文・ファイル内容・URL クエリは Relay の正規化段階で破棄する。

---

## 8. 画面要件

| 画面 | 優先度 | 内容 |
|---|---|---|
| オフィスビュー | P1 | メイン画面。フロア切替タブ / キャラホバーで詳細（セッション・現在ツール・経過時間） / 待ちパネル |
| セッション一覧サイド | P1 | キャラと 1:1。クリックでキャラへフォーカス |
| リプレイビュー | P2 | 日付選択 + シークバー + 速度切替 |
| レイアウトエディタ | P2 | FR-6 |
| 設定画面 | P2 | 組織リポジトリ登録 / 音 ON/OFF / setup 状態（doctor 結果）表示 |

---

## 9. マイルストーンと受入基準

| MS | 内容 | 受入基準 |
|---|---|---|
| **M0: PoC** | hooks → ingest → SSE → 最小描画 | 実セッションのツール実行が 1 秒以内に画面の状態変化として見える |
| **M1: ローカル α** | Relay / protocol / SQLite / スプライト / 組織インポート / 帰属 | domain-tech-collection のマスタから 3 部署の間取りが生成され、並列 3 セッション + サブエージェントが所属部屋で作業して見える。`npx ai-office setup` → `doctor` が green |
| **M2: リプレイ + 品質** | task-log リプレイ / エディタ / 通知音 / transcript フォールバック | 2026-07-17 朝の daily-digest（Actions 3 エージェント）がリプレイ再生できる。Idle 残留ゼロ |
| **M3: Vercel 公開** | 認証 ingest / Postgres / Realtime / 公開ページ | ローカル作業が公開 URL のオフィスに 3 秒以内に反映される |

---

## 10. リスクと対応

設計ドキュメント §9 を正とし、要件レベルの追加リスクのみ:

| リスク | 対応 |
|---|---|
| hooks 導入が他ツール（pixel-agents 併用等）の hooks と競合 | マーカー方式のマージ/teardown（§5.1）で自分の分だけを管理。doctor で競合検知 |
| masters/*.md のフォーマット変更で adapter が壊れる | adapter にスキーマバリデーション + 失敗時は前回生成 JSON で継続（graceful degradation） |
| 機微情報（プロンプト・コード片）のクラウド流出 | NFR-4 / §7 の Relay 段階での destructive filtering。Phase 2 前にフィルタのユニットテストを必須化 |
| 「見た目が可愛いだけ」で終わる | M1 受入基準に「待ちパネルで許可待ちを見逃さない」という実用価値を含める |

---

## 11. 用語集

| 用語 | 定義 |
|------|------|
| Relay | ローカル常駐の受信・正規化・転送プロセス。hooks の唯一の宛先 |
| OfficeEvent | 正規化済みイベント。ライブ/リプレイ共通の最小単位 |
| adapter | 組織定義（cc-sier 形式等）→ OfficeLayout/Character JSON への変換器 |
| 帰属（attribution） | セッション/イベントを組織・部署・ロールに紐付ける推定処理（FR-4） |
| dogfooding | 本アプリの開発作業を本アプリ自身で観測すること（§5.4） |
| 検証 hooks（B 系統） | ai-virtual-office リポジトリ自身に置く規約・テストの機械検証 hook。観測 hooks と異なり exit 2 で意図的にブロックする（§5.4） |
| Debug State API | dev/test ビルド限定でゲーム内部状態を公開する検査 API。E2E の主検証面（NFR-8） |

## 12. 参考リンク

- [【pixel-agents-hq/pixel-agents】](https://github.com/pixel-agents-hq/pixel-agents) — 参考実装
- [【Zenn: Pixel Agents 紹介記事】](https://zenn.dev/and_dot/articles/d987d07720929430)
- [【設計ドキュメント（本書の下位文書）】](./architecture-design.md)
- [【CC-SIer 要件定義書 v0.3】](https://github.com/SAS-Sasao/cc-sier-organization/blob/main/docs/requirements.md) — 理念の継承元
- [【Claude Code Hooks リファレンス】](https://code.claude.com/docs/en/hooks) / [【Settings リファレンス】](https://code.claude.com/docs/en/settings)

---
_作成: 2026-07-18 | /company（秘書室 direct）| 次アクション: レビュー確定 → /company-spawn で ai-virtual-office リポジトリ作成（本書 + 設計ドキュメントを docs/design/ へコピー）→ M0 着手_
