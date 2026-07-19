---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript ルール（.ts / .tsx 共通）

1. **型の正本は `packages/protocol`（Zod）**。`OfficeEvent` / `OfficeLayout` / `Character` を他パッケージで再定義しない。型は `z.infer` で導出する
2. **protocol を変更したら、`packages/relay` と `apps/web` 両方の関連テストを実行してから完了とする**（gate-protocol-consumers hook 導入までは手動で遵守）
3. `tsc --noEmit` が通る状態を維持する（typecheck-touched hook が編集ごとに自動検査。`AI_OFFICE_SKIP_TYPECHECK=1` は緊急時のみ、CI では逃げられない）
4. **機微情報（NFR-4）**: `tool_input` から保存してよいのは `tool_name` / `file_path`（ベース名まで）/ `subagent_type` のみ。プロンプト本文・ファイル内容・URL クエリは Relay の正規化段階で破棄するコードを書く。クラウド転送経路に乗せない
5. **テスタビリティ（NFR-8）は後付けしない**: 状態機械には Debug State API（`window.__OFFICE_DEBUG__`、dev/test ビルド限定）を最初から組み込む。production で tree-shake されることを unit テストで検証する
6. React 依存の可否はパスで決まる: `apps/web/game/` 配下は React 禁止（詳細は game-layer ルール）
