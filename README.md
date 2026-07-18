# ai-virtual-office

Claude Code のエージェント活動を、CC-SIer 仮想組織のピクセルオフィスとして可視化する Web アプリ（AI Virtual Office）。

## アーキテクチャ概要

1. Claude Code hooks がツール実行・セッション状態の変化を発火
2. ローカル常駐の Relay がイベントを受信・正規化・機微情報フィルタリング
3. ingest API がイベントを永続化し、SSE で Canvas オフィスへ配信

詳細は [docs/design/architecture-design.md](docs/design/architecture-design.md) / [docs/design/requirements.md](docs/design/requirements.md) を参照。

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
