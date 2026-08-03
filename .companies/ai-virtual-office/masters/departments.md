# 部署一覧

## dept-secretary

- **名称**: 秘書室
- **ステータス**: active
- **役割**: トップレベル（オーケストレータ）セッションの受付。visitor の窓口
- **対応Subagent**: []
- **トリガーワード**: [TODO, 相談, 進め方, 全体方針]

## dept-game

- **名称**: ゲームエンジン部
- **ステータス**: active
- **役割**: Canvas 2D 描画・状態機械・経路探索（apps/web/game 専任）
- **対応Subagent**: [game-engine-dev]
- **トリガーワード**: [Canvas, スプライト, 経路探索, ゲームループ, レンダラー]

## dept-pipeline

- **名称**: パイプライン部
- **ステータス**: active
- **役割**: Relay/protocol/ingest（イベントパイプライン）
- **対応Subagent**: [pipeline-dev]
- **トリガーワード**: [Relay, protocol, ingest, hooks, 正規化]

## dept-ui

- **名称**: UI 部
- **ステータス**: active
- **役割**: Next.js/React シェル・画面
- **対応Subagent**: [ui-dev]
- **トリガーワード**: [UI, 画面, Next.js, React, SSE]

## dept-adapter

- **名称**: アダプタ部
- **ステータス**: active
- **役割**: cc-sier-adapter（組織インポート・リプレイ変換）
- **対応Subagent**: [org-adapter-dev]
- **トリガーワード**: [adapter, インポート, masters, リプレイ]

## dept-quality

- **名称**: 品質保証部
- **ステータス**: active
- **役割**: 設計レビュー・実装検証（office-qa checker）
- **対応Subagent**: [office-qa]
- **トリガーワード**: [レビュー, 検証, QA]
