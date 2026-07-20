# ai-virtual-office

Claude Code のエージェント活動を、CC-SIer 仮想組織のピクセルオフィスとして可視化する Web アプリ（AI Virtual Office）。

> **参考プロジェクト**: 本アプリは [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)（Claude Code エージェントをピクセルアートオフィスで可視化する VS Code 拡張 / CLI）にインスパイアされています。基本アイデア（Claude Code hooks / JSONL トランスクリプトの二系統イベント取得、Canvas 2D + キャラクター状態機械、ツール実行 → アニメーション写像）は同プロジェクトの分析に基づき、そこに **CC-SIer 仮想組織のマスタ駆動オフィス生成**（部署 = 部屋、ロール = キャラ）、**task-log リプレイ**、**クラウド配信**を独自要素として加えた別実装です。

## アーキテクチャ概要

1. Claude Code hooks がツール実行・セッション状態の変化を発火
2. ローカル常駐の Relay がイベントを受信・正規化・機微情報フィルタリング
3. ingest API がイベントを永続化し、SSE で Canvas オフィスへ配信

詳細は [docs/design/architecture-design.md](docs/design/architecture-design.md) / [docs/design/requirements.md](docs/design/requirements.md) を参照。

## 参考リンク

- [pixel-agents (pixel-agents-hq)](https://github.com/pixel-agents-hq/pixel-agents) — 参考実装（本家）。Hooks/JSONL 二系統・Canvas 2D 状態機械の設計参考
- [Zenn: Claude Code を眺めて楽しむ Pixel Agents](https://zenn.dev/and_dot/articles/d987d07720929430) — 使用感・既知の課題の参考記事
- [Claude Code Hooks リファレンス](https://code.claude.com/docs/en/hooks) — イベント取得の正本仕様

## セットアップ

```bash
# 前提: Node 20+。pnpm は corepack で有効化する（packageManager: pnpm@9.0.0 準拠）
corepack enable && corepack prepare pnpm@9.0.0 --activate
pnpm install
```

環境の検証・構築を Claude Code に任せる場合は [docs/dev-environment.md](docs/dev-environment.md)（AI 指示書。マイルストーン別の要否と現状ギャップを整理）を読ませて実行させる。

## 起動とローカルアクセス（M0 PoC）

```bash
pnpm dev   # apps/web を http://localhost:3001 で起動（next dev -p 3001）
```

- **アクセス方法（本開発環境 = WSL2 Ubuntu 22.04）**: WSL2 の localhost フォワーディングにより、**Windows 側のブラウザから `http://localhost:3001`** を開く。WSL 内からの疎通確認は `curl -s http://localhost:3001/`
- **ポートが 3000 でない理由**: 本環境ではポート 3000 を WSL 外の別プロセスが占有しているため、3001 に固定している（`apps/web/package.json` の dev script）。変更する場合は `.claude/settings.json` の観測 hooks の URL も揃えること
- 画面には実セッションのキャラ（正方形）が状態色で表示される。イベントが無い間は空のオフィスのみ

### イベントを手動注入して動作確認する

サーバ起動中に別ターミナルから:

```bash
# ツール実行イベントを注入（キャラが出現し「編集」色 #7ef29a になる）
curl -s -X POST http://localhost:3001/api/ingest \
  -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"PreToolUse","session_id":"demo-1","tool_name":"Edit","tool_input":{"file_path":"/tmp/demo.ts"}}'

# SSE ストリームを直接覗く（別ターミナルで）
curl -N http://localhost:3001/api/stream
```

### 実セッションの観測（dogfooding）

本リポジトリの `.claude/settings.json` には観測 hooks（A 系統・`#ai-office` マーカー付き）が配線済みで、**このリポジトリで Claude Code を使うと自動で `http://localhost:3001/api/ingest` にイベントが飛ぶ**（サーバ停止中は `--max-time 2 || true` で無害に失敗し、Claude Code を一切ブロックしない = NFR-2）。設定変更後の hooks はセッション再起動で有効になる。

> 注: 観測 hooks（A 系統・インライン curl）は要件 §5.2 準拠。`.claude/hooks/verify/*.sh` を呼ぶ検証 hooks（B 系統・違反時にブロック）とは別系統であり、`.claude/rules/shell.md` の系統区別を参照。

## 開発ワークフロー（Claude Code）

本リポジトリは Claude Code での開発を前提に、`.claude/` に検証ループ一式を備えています（設計の正本: [docs/design/loop-engineering-design.md](docs/design/loop-engineering-design.md)）。

### 開発を開始するとき

| コマンド / 呼び出し | 用途 |
|---|---|
| `/office-develop` | **機能開発の標準サイクル**。設計 → 設計レビュー → 実装（TDD）→ 実装レビュー → E2E → PR 反映の 6 フェーズを統合実行する。機能追加・改修はまずこれを使う |
| `/office-verify` | **機械的な動作確認**。`scripts/verify.sh` を実行し exit code で合否判定（目視判断を挟まない停止条件） |
| 「レビューして」「検証して」「QA」 | 検証専任 subagent **office-qa** が起動し、6 軸採点の verdict JSON で合否を返す（Write/Edit を持たない checker） |

実装は担当モジュールの maker subagent（`game-engine-dev` / `pipeline-dev` / `ui-dev` / `org-adapter-dev`）に委譲される。

### 自動で走る検証 hooks（B 系統 = 違反時にブロックする仕様）

Edit / Write のたびに PostToolUse で以下が実行される。exit 2 でブロックされたら stderr の指示に従って修正する:

- `guard-game-react.sh` — `apps/web/game/` への react / react-dom / next import を検出（NFR-7: game 層の React 非依存）
- `typecheck-touched.sh` — 編集した .ts / .tsx の所属パッケージに `tsc --noEmit`（緊急時は `AI_OFFICE_SKIP_TYPECHECK=1` でスキップ可。CI では全量 typecheck が走る）

Stop hooks（protocol 両系テスト / テスト弱体化ガード / E2E スモーク）は対象成立後に導入予定（設計書 §2.3）。

## ロードマップ

- **M0: PoC** — hooks → ingest → SSE → 最小描画（実セッションの変化が 1 秒以内に画面へ反映される）
- **M1: ローカル α** — Relay 分離 / protocol パッケージ化 / SQLite 永続化 / スプライト・状態機械 / cc-sier-adapter による組織インポート
- **M2: リプレイ + 品質** — task-log リプレイ / レイアウトエディタ / 通知音 / transcript フォールバック
- **M3: Vercel 公開** — 認証付き ingest / Postgres / Supabase Realtime / 公開ページ

## ライセンス表記

ピクセルアート素材は CC0 / CC-BY 系のみを使用予定です。素材採用時はここと画面フッターの両方に出典を明記します。

（現時点では素材未採用のため記載なし）
