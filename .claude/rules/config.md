---
paths:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
---

# 設定ファイルルール（.json / .yaml / .yml）

1. **`.claude/settings.json`**: hooks は「配線のみ」。コマンド文字列にロジック（パイプ・条件分岐）を書かず、`.claude/hooks/verify/*.sh` を呼ぶだけにする。permissions.allow は必要最小限（追加はマイルストーンの必要が生じたときのみ。例: playwright は M1 で追加）
2. **`package.json`**: `packageManager` は `pnpm@9.0.0` に固定。pnpm からの更新案内が出ても勝手に上げない（上げる場合は人間の判断 + 全パッケージでの動作確認）。scripts を追加・変更したら `office-verify` の verify.sh との整合を確認する
3. **`pnpm-lock.yaml`**: 手編集禁止。`pnpm install` の結果のみをコミットする
4. **`pnpm-workspace.yaml`**: パッケージ追加は `apps/*` / `packages/*` の既存 glob に従う（リポジトリ構成 = アーキ設計 §5 を崩さない）
5. 編集後は妥当性を機械確認する: JSON は `jq empty <file>`、YAML はパーサで parse 確認
6. 機微情報（トークン・URL・個人パス）を設定ファイルにハードコードしない。`~/.ai-office/config.json` 等のユーザー設定はリポジトリ外に置く
