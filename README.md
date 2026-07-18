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

現時点では開発準備中です（M0 PoC 未着手）。設計内容は `docs/design/` を参照してください。

## ロードマップ

- **M0: PoC** — hooks → ingest → SSE → 最小描画（実セッションの変化が 1 秒以内に画面へ反映される）
- **M1: ローカル α** — Relay 分離 / protocol パッケージ化 / SQLite 永続化 / スプライト・状態機械 / cc-sier-adapter による組織インポート
- **M2: リプレイ + 品質** — task-log リプレイ / レイアウトエディタ / 通知音 / transcript フォールバック
- **M3: Vercel 公開** — 認証付き ingest / Postgres / Supabase Realtime / 公開ページ

## ライセンス表記

ピクセルアート素材は CC0 / CC-BY 系のみを使用予定です。素材採用時はここと画面フッターの両方に出典を明記します。

（現時点では素材未採用のため記載なし）
