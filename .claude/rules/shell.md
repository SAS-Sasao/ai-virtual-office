---
paths:
  - "**/*.sh"
---

# シェルスクリプトルール（.sh）

**書く前に、どちらの系統かを必ず判定する（設計書 §1.2。取り違えると要件違反になる）:**

| 系統 | 対象 | 規約 |
|---|---|---|
| 検証 hooks（B） | `.claude/hooks/verify/` 配下 | `set -euo pipefail` 必須。`2>/dev/null` や `\|\| true` でのエラー握り潰し禁止。違反検出時は **exit 2 + stderr に修正指示**（ブロックが仕様） |
| 観測 hooks（A） | 観測対象プロジェクトへ配布する hooks（setup CLI） | `curl -s ... --max-time 2 \|\| true` 必須。**絶対に exit 2 を返さない**（NFR-2。Claude Code を一切ブロックしない） |

共通:

1. 外部コマンド依存（jq 等）は冒頭で `command -v` を確認し、無ければ stderr に通知して exit 0（フェイルオープン）
2. `.claude/settings.json` にはロジックを書かない（配線のみ）。ロジックはすべて .sh 側に置く
3. 完了前に `bash -n` で構文確認し、擬似 stdin JSON での単体テスト（期待 exit code の確認）を行う
4. 新規スクリプトは `chmod +x` を忘れない
5. 検証 hooks は実行時間の目安を守る（PostToolUse = 即時勾配・数秒以内、Stop = 〜90 秒）
