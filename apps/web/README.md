# apps/web

Next.js 15（App Router）による UI + ingest/stream API。

- `game/` は React に依存しないゲームロジック層（OfficeState / 状態機械 / BFS 経路探索 / Canvas 2D 描画）。React はあくまで外枠（画面・ルーティング・SSE 購読）のみを担当する。
- 詳細は `docs/design/architecture-design.md` §5 リポジトリ構成を参照。
