# AI 仮想オフィス 構築設計ドキュメント

> 作成日: 2026-07-17 | 作成者: SAS-Sasao（秘書室 direct）| ステータス: draft
> 更新: 2026-07-20 — フロントモック v3 の取り込みに伴い **§5.1 オフィス描画のレイヤー構成**を新設（[ADR-002](./decision-log.md)）
> 参考: [【pixel-agents-hq/pixel-agents】](https://github.com/pixel-agents-hq/pixel-agents) / [【Zenn: Pixel Agents 紹介記事】](https://zenn.dev/and_dot/articles/d987d07720929430)

## 1. 目的とスコープ

Claude Code のエージェント活動をピクセルアート風の仮想オフィスで可視化する **独立アプリケーション** を新規リポジトリで開発する。

| 項目 | 方針 |
|---|---|
| リポジトリ | cc-sier-organization とは**別の専用リポジトリ**（本格プロダクトとして開発） |
| デプロイ | 将来 **Vercel**。当面は**ローカル実行のみ** |
| **CC-SIer 組織の取り込み** | **コア要件**。仮想オフィスは CC-SIer の仮想組織（部署 = 部屋、ロール = キャラクター）を表現する。マスタ駆動で間取り・住人を生成する（§10） |
| 本ドキュメントの範囲 | 技術選定 / アーキテクチャ / リポジトリ構成 / Claude Code 側の設定 / CC-SIer 組織取り込み設計 / ロードマップ |
| 範囲外 | ピクセルアート素材の制作詳細 |

## 2. 参考実装（pixel-agents）の分析

pixel-agents の本質は「**Claude Code のイベントストリームを、オフィスのキャラクター状態機械に写像する**」こと。構造は 4 層で、Claude Code 本体は無改造。

| 層 | pixel-agents の実装 | 学ぶべき点 |
|---|---|---|
| データ取得 | ① Claude Code Hooks API → ローカル Fastify に POST ② `~/.claude/projects/**/*.jsonl` ポーリング（フォールバック） | 二系統設計。Hooks が主、transcript が保険 |
| 状態変換 | ツール名 → キャラ状態のマッピング（Write→typing / Read→reading / 入力待ち→吹き出し） | ただの変換テーブル。ここに複雑さは不要 |
| 描画 | Canvas 2D + 自前ゲームループ（BFS 経路探索、idle→walk→type 状態機械）。React は外枠のみ | **ゲームエンジン不使用**で成立している |
| 配布 | VS Code 拡張 + スタンドアロン CLI | 本プロジェクトは Web アプリに一本化 |

既知の弱点（Zenn 記事より）: 起動ディレクトリ固定 / 作業詳細が見えにくい / セッション終了後の Idle キャラ残留。これらは本プロジェクトの改善ポイントになる。

## 3. 全体アーキテクチャ

### 3.1 イベントパイプライン（共通の骨格）

```
Claude Code (複数セッション)
  │  Hooks (SessionStart / PreToolUse / PostToolUse / Stop / ...)
  ▼
[Relay]  ローカル常駐の軽量プロセス（イベント正規化・バッファリング）
  │
  ▼
[Event Store + Realtime]  イベント永続化と購読配信
  │
  ▼
[Web UI]  Canvas 2D オフィス描画（キャラ状態機械・経路探索）
```

**Relay を独立させるのが最重要の設計判断**。理由:

1. Claude Code の hooks は **localhost にしか POST できない**（curl 実行）。Vercel 化しても「ローカルの Relay → クラウドへ転送」の形は変わらないため、最初から分離しておくと Phase 2 で UI/Store だけ差し替えられる
2. hooks はセッションごと・ツール実行ごとに発火し瞬間的に多発する。Relay でバッファ/重複排除/再送を吸収する
3. 将来 Claude Code 以外のソース（GitHub Actions 上のエージェント、他の AI CLI）を足す時の受け口になる

### 3.2 Phase 1: ローカル構成（当面）

```
Claude Code ──curl──▶ Relay (Node, localhost:4100)
                        │ 正規化イベント
                        ▼
                     Next.js dev (localhost:3000)
                       ├─ Route Handler /api/ingest  ← Relay から POST
                       ├─ SQLite (better-sqlite3) にイベント永続化
                       └─ /api/stream (SSE) ──▶ ブラウザ Canvas UI
```

- ローカルでは Next.js を `next dev`（または `next start`）の**常駐プロセス**として使えるため、SSE（Server-Sent Events）で十分。WebSocket は不要
- 最小構成なら Relay を省略し hooks から直接 `/api/ingest` に curl も可能（M0 PoC はこれで良い）。M1 で Relay を分離する

### 3.3 Phase 2: Vercel 構成（将来）

Vercel は **serverless/edge のため「常駐 WebSocket サーバ」が持てない**。また hooks はユーザーのローカルで発火する。よって:

```
Claude Code ──curl──▶ Relay (ローカル常駐)
                        │ HTTPS + トークン認証で転送
                        ▼
                     Vercel (Next.js)
                       ├─ /api/ingest（認証付き Route Handler）
                       ├─ DB: Vercel Postgres / Neon / Supabase
                       └─ Realtime: Supabase Realtime または Pusher/Ably
                            └──▶ ブラウザ Canvas UI（公開 or 認証付き）
```

- **Realtime はマネージドサービスに委譲**（Supabase Realtime 推奨: DB とセットで済む）。Vercel 単体で頑張るなら SSE + ポーリングハイブリッドだが、体験が落ちる
- Relay からの転送は `AUTH_TOKEN`（環境変数）による Bearer 認証。オフィスを公開する場合でも ingest だけは必ず認証
- **リプレイモード**（イベントを時刻順に再生）を最初から設計に入れると、「ライブは Relay 必須、公開デモはリプレイ」と綺麗に分離できる

## 4. 技術スタック選定

| 領域 | 推奨 | 代替 | 選定理由 |
|---|---|---|---|
| 言語 | TypeScript（全域） | — | Relay/UI/スキーマを 1 言語で共有 |
| フレームワーク | Next.js 15 (App Router) + React 19 | Vite + React SPA + 別 API サーバ | Vercel デプロイ前提なら Next.js 一択。ローカルでも同一コードで動く |
| 描画 | **素の Canvas 2D + 自前ゲームループ** | Phaser 3 / PixiJS | pixel-agents が Canvas 2D で成立済み。タイルマップ+スプライト数十体に物理演算は不要。Phaser はバンドル肥大とReact統合の複雑さが割に合わない |
| ゲーム状態管理 | React 外の命令的 `OfficeState` クラス（requestAnimationFrame ループ）。React は UI シェルのみ | Zustand に載せる | 60fps の位置更新を React state に流すと再レンダリング地獄になる。pixel-agents と同じ分離が正解 |
| イベントスキーマ | **Zod**（`packages/protocol` で共有） | JSON Schema / AsyncAPI | Relay と UI で単一の型定義を共有。pixel-agents は AsyncAPI 3.0 だが小規模チームには Zod が実用的 |
| Relay | Node 20+ 単体 CLI（Fastify or Hono） | Bun | npx 一発起動にする。Fastify は pixel-agents 実績あり、Hono は将来 edge 共用可 |
| DB（ローカル） | SQLite（better-sqlite3 or Drizzle + libsql） | JSON ファイル | イベントログは追記型なので SQLite で十分。Drizzle を挟むと Phase 2 の Postgres 移行が楽 |
| DB（Vercel） | Neon / Vercel Postgres / Supabase | PlanetScale | Drizzle でスキーマ共有。Supabase なら Realtime も同時解決 |
| Realtime（ローカル） | SSE（Route Handler） | socket.io | 単方向配信なので SSE で足りる。実装も運用も最軽量 |
| Realtime（Vercel） | Supabase Realtime | Pusher / Ably / PartyKit | serverless で WebSocket を持てない制約の標準解 |
| ピクセル素材 | LPC（Liberated Pixel Cup）系 CC-BY-SA / itch.io の CC0 アセット | 自作 / 生成 AI | キャラ 4 方向歩行 + 着席 + タイピングの最小セットから開始。ライセンス表記を README に明記 |
| テスト | Vitest（protocol / relay / 状態機械） | Jest | 状態機械とイベント正規化はユニットテストの費用対効果が高い。描画はテスト対象外で割り切る |
| パッケージ管理 | pnpm workspaces（monorepo） | npm workspaces / turborepo | 3 パッケージ規模なら pnpm 素で十分。ビルド増えたら turbo 追加 |

## 5. リポジトリ構成

```
ai-virtual-office/
├── apps/
│   └── web/                    ← Next.js 15（UI + ingest/stream API）
│       ├── app/
│       │   ├── page.tsx        ← オフィスビュー（Canvas マウント）
│       │   ├── replay/         ← リプレイモード
│       │   └── api/
│       │       ├── ingest/route.ts   ← イベント受信（POST、Phase 2 で認証）
│       │       └── stream/route.ts   ← SSE 配信
│       ├── game/               ← React 非依存のゲームロジック（最重要領域）
│       │   ├── office-state.ts       ← OfficeState（キャラ・家具・部屋）
│       │   ├── state-machine.ts      ← idle/walk/type/read/waiting 遷移
│       │   ├── pathfinding.ts        ← BFS（タイルグリッド）
│       │   ├── renderer.ts           ← Canvas 2D 描画・整数ズーム（レイヤー順は §5.1）
│       │   └── sprites/              ← スプライトシート定義（PNG + フレーム定義）
│       ├── db/                 ← Drizzle スキーマ + SQLite/Postgres 接続
│       └── public/assets/      ← ピクセルアート素材（ライセンス表記必須）
├── packages/
│   ├── protocol/               ← Zod イベントスキーマ（Relay/Web で共有）
│   │   ├── src/events.ts       ← OfficeEvent 型（正規化済みイベント）
│   │   └── src/layout.ts       ← OfficeLayout / Character 型（間取り・住人定義・任意の backdrop）
│   ├── relay/                  ← ローカル常駐 CLI（npx ai-office-relay）
│   │   └── src/
│   │       ├── server.ts       ← POST /hooks/:sessionId 受信
│   │       ├── normalize.ts    ← Claude hooks JSON → OfficeEvent 変換
│   │       └── forward.ts      ← ローカル/クラウドへの転送・再送バッファ
│   └── cc-sier-adapter/        ← CC-SIer 組織インポータ（§10、コア要件）
│       └── src/
│           ├── import-org.ts   ← masters/*.md → OfficeLayout + Character[] 生成
│           ├── import-tasklog.ts ← .task-log/*.md → OfficeEvent[]（リプレイ用）
│           └── attribute.ts    ← ライブセッション → 部署/ロール帰属の推定
├── docs/
│   ├── architecture.md
│   └── claude-setup.md         ← §6 の内容を利用者向けに転記
├── pnpm-workspace.yaml
├── turbo.json                  ← （任意、ビルドが増えたら）
└── CLAUDE.md                   ← 新リポジトリ用の開発ルール
```

設計原則:

- **`apps/web/game/` は React に依存させない**。ここが資産の核で、テスト可能・移植可能に保つ
- **`packages/protocol` が唯一の真実**。Claude Code の生 hooks JSON を UI まで持ち込まず、Relay で正規化して境界を切る
- リプレイモードは「OfficeEvent の配列を時刻順に流す」だけで実装できるよう、ライブ/リプレイ共通のイベント消費インターフェースにする
- **オフィスの見た目は手続き描画が正**。フロア背景の一枚絵は任意の装飾レイヤーに留める（§5.1 / ADR-002）

### 5.1 オフィス描画のレイヤー構成

フロントモック v3（2026-07-20）は一枚絵背景 + PNG スプライトへ移行したが、**実装はそれをそのまま採らない**。一枚絵に全面移行すると FR-3（マスタからの間取り生成）と FR-6（エディタでの家具配置）が成立せず、BFS の通行可否も画像から復元できないため。決定の経緯は [ADR-002](./decision-log.md) を参照。

`renderer.ts` の描画順:

| z | レイヤー | 生成元 | 必須 |
|---|---|---|---|
| 0 | `backdrop`（フロア一枚絵） | 手描き素材。`OfficeLayout.backdrop` で任意指定 | 任意 |
| 1 | 床・壁・部屋 | `OfficeLayout`（cc-sier-adapter がマスタから生成） | **必須** |
| 2 | 家具 | `OfficeLayout.furniture`（エディタで編集・`custom` フラグ） | **必須** |
| 3 | キャラクター | PNG スプライトシート + 状態機械 | **必須** |
| 4 | オーバーレイ（吹き出し・サブエージェントのリンク線・ホバーカード・ホワイトボード拡大） | ランタイム状態 | **必須** |

不変条件:

- **レイヤー 1〜2 のデータは `backdrop` の有無にかかわらず常に存在する**。当たり判定・経路探索・エディタはこのデータのみを参照し、背景画像を参照しない
- `backdrop` 指定時はレイヤー 1〜2 を簡略描画に落としてよい（部屋の枠線・名前プレートは残す）が、**`backdrop` 未指定でも単体で成立する見た目**を維持する
- `backdrop` の座標系は `OfficeLayout` のタイルグリッドに一致させる（`cover` によるスケール差を持ち込まない）
- 素材は CC0 / CC-BY 系のみ（NFR-6）。モックの `sprites/*.png` / `uploads/*.png` はプレースホルダーであり流用しない

## 6. Claude Code 側に必要な設定

### 6.1 Hooks 設定（主系）

利用者の `~/.claude/settings.json`（全プロジェクト対象）またはプロジェクトの `.claude/settings.json` に追記する:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
        "command": "curl -s -X POST http://localhost:4100/hooks/session-start -H 'Content-Type: application/json' -d @- --max-time 2 || true" } ] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command",
        "command": "curl -s -X POST http://localhost:4100/hooks/pre-tool -H 'Content-Type: application/json' -d @- --max-time 2 || true" } ] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command",
        "command": "curl -s -X POST http://localhost:4100/hooks/post-tool -H 'Content-Type: application/json' -d @- --max-time 2 || true" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command",
        "command": "curl -s -X POST http://localhost:4100/hooks/notification -H 'Content-Type: application/json' -d @- --max-time 2 || true" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "curl -s -X POST http://localhost:4100/hooks/stop -H 'Content-Type: application/json' -d @- --max-time 2 || true" } ] }
    ],
    "SubagentStop": [
      { "hooks": [ { "type": "command",
        "command": "curl -s -X POST http://localhost:4100/hooks/subagent-stop -H 'Content-Type: application/json' -d @- --max-time 2 || true" } ] }
    ]
  }
}
```

設計上の注意:

- hook の stdin には `session_id` / `transcript_path` / `cwd` / `hook_event_name` / `tool_name` / `tool_input` 等の JSON が渡る。`-d @-` で丸ごと Relay へ転送し、**正規化は Relay 側で行う**（settings.json 側のロジックは最小に保つ）
- **`--max-time 2 || true` は必須**。Relay が起動していない時に Claude Code の動作をブロック・失敗させないため（hooks の exit code 2 はツール実行をブロックするので絶対に返さない）
- どの hook をどう可視化に使うかは §7 のマッピング表を参照

### 6.2 Transcript ポーリング（保険系）

hooks 未設定のプロジェクトや取りこぼし対策として、Relay に `~/.claude/projects/<project-hash>/<session-id>.jsonl` の watch 機能を実装する（pixel-agents と同方式）。ファイル追記を tail してツールイベントを復元する。M2 以降の実装で良い。

### 6.3 サブエージェントの追跡

- 親セッションの `PreToolUse`（`tool_name: "Task"`）でサブエージェント生成を検知 → オフィスに新キャラを spawn
- `SubagentStop` で退出（デスクを片付けて離席）
- pixel-agents の「親エージェントとのリンク表示」は、spawn 時に親 session_id を紐付ければ再現できる

### 6.4 新リポジトリの CLAUDE.md（開発用）

新リポジトリ側には開発ルールとして最低限を記載: pnpm monorepo コマンド / `game/` は React 非依存を維持 / protocol 変更時は relay と web 両方のテスト実行 / 素材ライセンス表記の維持。

## 7. イベント → キャラ状態マッピング（初期案）

| Claude Code イベント | 条件 | キャラ状態 | 演出 |
|---|---|---|---|
| SessionStart | — | 出社 | 入口から歩いてデスクへ（BFS） |
| PreToolUse | Write / Edit / NotebookEdit | typing | デスクでタイピング + コード風パーティクル |
| PreToolUse | Read / Glob / Grep | reading | 書類を読む姿勢 |
| PreToolUse | Bash | terminal | 別モニタを覗き込む |
| PreToolUse | WebFetch / WebSearch | browsing | 電話 or 新聞（お好みで） |
| PreToolUse | Task | spawn | 会議室に新キャラ出現、親とライン表示 |
| PostToolUse | 連続イベント途絶 3s | thinking | 腕組み・頭上に「…」 |
| Notification | permission 要求 / 入力待ち | waiting | **吹き出し + 点滅**（最重要 UX。一覧性を pixel-agents より改善する） |
| Stop | — | done | 伸びをして待機 → 一定時間後に退社アニメ（Idle 残留バグの改善点） |
| SubagentStop | — | leave | 会議室から退出 |

## 8. 開発ロードマップ

| マイルストーン | 内容 | 完了条件 |
|---|---|---|
| **M0: PoC（〜1週間）** | Next.js 単体。hooks → `/api/ingest` 直接 POST → SSE → 四角いキャラがデスクで色が変わるだけ | 実セッションのイベントがブラウザに 1 秒以内に反映される |
| **M1: ローカル α** | Relay 分離 / protocol パッケージ化 / SQLite 永続化 / スプライト・歩行・状態機械 / 複数セッション / **cc-sier-adapter による組織インポート（部署 = 部屋、ロール = キャラ）** | 並列 3 セッション + サブエージェントが別キャラで見え、オフィスの間取りが CC-SIer のマスタから生成される |
| **M2: 品質・リプレイ** | transcript フォールバック / リプレイモード（**task-log リプレイで Actions 部隊も再生**）/ オフィスレイアウトエディタ（JSON 保存、マスタ生成分は上書き保護） / 通知音 | 過去イベントの再生（daily-digest の朝の活動含む）と、pixel-agents 既知バグ（Idle 残留等）の解消 |
| **M3: Vercel 公開** | ingest 認証 / Drizzle→Postgres / Supabase Realtime / Relay の cloud-forward モード | ローカルの作業がインターネット経由のオフィスページに反映される |

## 9. リスクとハマりどころ

| リスク | 対策 |
|---|---|
| hooks の curl がエージェント動作をブロック | `--max-time 2 || true` を全 hook に徹底。exit 2 を返さない |
| イベント多発時の描画負荷・順序乱れ | Relay でシーケンス番号付与 + UI 側は状態機械が吸収（イベント欠落しても最終状態に収束する設計に） |
| Vercel で WebSocket 不可 | 最初から SSE + マネージド Realtime 前提で設計（§3.3）。「Vercel に常駐サーバを置く」発想を捨てる |
| ingest エンドポイントの露出（Phase 2） | Bearer トークン必須 + レート制限。公開するのは閲覧ページのみ |
| Claude Code hooks 仕様の変更 | 生 JSON を protocol で正規化して境界を切ってあるので、追従は Relay の normalize.ts のみで済む |
| 素材ライセンス | CC0 / CC-BY 系のみ使用し、出典を README と画面フッターに明記 |
| Next.js App Router で SSE が buffering される | Route Handler で `dynamic = 'force-dynamic'` + ReadableStream 実装を確認（M0 で最初に検証する） |

## 10. CC-SIer 組織の取り込み設計（コア要件）

仮想オフィスの「間取りと住人」は手作業のレイアウトエディタではなく、**CC-SIer のマスタデータから生成する**。組織定義駆動が本プロダクトの pixel-agents に対する最大の差別化点。

### 10.1 マスタ → オフィス概念のマッピング

| CC-SIer 側 | オフィス側 | 生成ルール |
|---|---|---|
| `.companies/{org}/masters/organization.md` | オフィス（フロア）名・看板 | 組織名をフロアエントランスに表示。複数組織 = 複数フロア（domain-tech-collection / jutaku-dev-team / standardization-initiative） |
| `masters/departments.md` の各部署 | 部屋 | 部署 1 つ = 部屋 1 つ。`ステータス: active` のみ描画（standby はドア閉鎖表示） |
| `masters/roles.md` の各ロール | 常駐キャラクター | ロール 1 つ = キャラ 1 体 + 専用デスク。所属部署の部屋に配置 |
| secretary | 受付キャラ | エントランス脇に常駐。タスク受付時に該当部署へ歩いて委譲する演出 |
| Agent Teams / サブエージェント | 臨時キャラ | 会議室に spawn し、終了で退出（§6.3） |
| `masters/workflows.md` | ワークフロー演出（任意） | wf-daily-digest 等の定義済みフローは、関与ロールの部屋間移動としてアニメ化 |

インポートは `cc-sier-adapter` の CLI で実行し、`office-layout.json` + `characters.json`（`packages/protocol` の型）を生成する。**アプリ本体は CC-SIer を知らない**（生成された JSON しか読まない）ため、汎用性と組織固有性を両立できる。マスタ変更後の再インポートは冪等（手動編集分は `custom` フラグで保護）。

### 10.2 ライブセッションの部署帰属

hooks イベントにはツール情報しかないため、「このセッションはどの部署の仕事か」を推定する:

1. hook stdin の `cwd` が cc-sier リポジトリ → `.companies/.active` から組織を特定
2. カレントブランチ名の org-slug / type プレフィックス（`{org}/{type}/...`）から部署を推定
3. `PreToolUse (Task)` の subagent_type（tech-researcher 等）→ `roles.md` 経由で所属部署に帰属
4. 判定不能 → 秘書室（受付）に帰属させる

### 10.3 task-log リプレイ（Actions 部隊の可視化）

GitHub Actions 上の daily-digest（tech 巡回 / retail 巡回 / L2 レビュアーの 3 エージェント）はローカル hooks では捕捉できない。cc-sier の `.task-log/*.md` は「[時刻] secretary → general-purpose-tech 委譲」形式のタイムスタンプ付きログを持つため、`import-tasklog.ts` で OfficeEvent 列に変換してリプレイ再生する。これにより「朝 8 時のオフィスで巡回部隊が働いていた様子」を後から観られる。

### 10.4 リポジトリ立ち上げ手順

着手時は `/company-spawn` で `ai-virtual-office` リポジトリを新規作成し、本設計ドキュメントを `docs/design/` にコピーして開始する（spawn の追跡情報は新リポジトリの `docs/design/origin.md` に記録される）。

## 11. 次のアクション

1. 本ドキュメントのレビュー・方針確定（特に: Supabase を使うか / Realtime の選定）
2. `/company-spawn` で `ai-virtual-office` リポジトリを新規作成（本ドキュメントを持参）
3. M0 PoC: hooks → ingest → SSE → 色変わるだけの最小ループを 1 日で通す

## 12. 参考リンク

| 種別 | リンク | 用途 |
|---|---|---|
| 参考実装（本家） | [【pixel-agents-hq/pixel-agents】](https://github.com/pixel-agents-hq/pixel-agents) | アーキテクチャ全体の参考。VS Code 拡張 + CLI、Hooks/JSONL 二系統、Canvas 2D 状態機械 |
| 紹介記事 | [【Zenn: Claude Code を眺めて楽しむ Pixel Agents】](https://zenn.dev/and_dot/articles/d987d07720929430) | 使用感・ハマりどころ（起動ディレクトリ固定、Idle 残留バグ等） |
| Claude Code Hooks 公式 | [【Hooks リファレンス】](https://code.claude.com/docs/en/hooks) | hook イベント種別・stdin JSON スキーマ・exit code 仕様（§6.1 の正本） |
| Claude Code 設定 | [【Settings リファレンス】](https://code.claude.com/docs/en/settings) | settings.json の配置階層（user / project / local） |
| ピクセル素材 | [【LPC (Liberated Pixel Cup)】](https://lpc.opengameart.org/) / [【OpenGameArt】](https://opengameart.org/) / [【itch.io game assets】](https://itch.io/game-assets/free) | CC ライセンスのキャラ・タイル素材（採用時はライセンス表記必須） |
| Realtime 候補 | [【Supabase Realtime】](https://supabase.com/docs/guides/realtime) / [【Pusher】](https://pusher.com/) | Phase 2 の Vercel 構成で使用（§3.3） |

---
_情報源: pixel-agents GitHub README / Zenn 記事（2026-07-17 参照）/ Claude Code Hooks 仕様_
