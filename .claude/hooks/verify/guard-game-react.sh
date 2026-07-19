#!/usr/bin/env bash
# guard-game-react.sh — game/ React 非依存ガード【PostToolUse / B 系統・検証 hook】
#
# NFR-7「apps/web/game/ は React 非依存」の機械化（設計書 §2.2）。
# exit 0 = pass / exit 2 = block（stderr が Claude にフィードバックされる）。
set -euo pipefail

# jq が無い環境ではフェイルオープン（ブロックせず通す）
if ! command -v jq >/dev/null; then
  echo "guard-game-react: jq が見つからないため検証をスキップしました（fail-open）" >&2
  exit 0
fi

file_path=$(jq -r '.tool_input.file_path // empty')

# file_path を持たないイベント / 対象外パスは pass
[[ -n "$file_path" ]] || exit 0
[[ "$file_path" == *"apps/web/game/"* ]] || exit 0
[[ -f "$file_path" ]] || exit 0

if hits=$(grep -nE "from ['\"](react|react-dom|next)(/[^'\"]*)?['\"]" "$file_path"); then
  {
    echo "apps/web/game/ は React 非依存が規約（NFR-7）。該当 import を削除し、"
    echo "React 連携が必要なら apps/web 側のアダプタ層に置くこと。検出行:"
    echo "$hits"
  } >&2
  exit 2
fi

exit 0
