#!/usr/bin/env bash
# typecheck-touched.sh — 触ったパッケージの型検査【PostToolUse / B 系統・検証 hook】
#
# 編集された .ts / .tsx の所属 workspace パッケージに対して tsc --noEmit を実行する
# （設計書 §2.2）。exit 0 = pass / exit 2 = block。
#
# 【現状対応】M0 未着手でパッケージが骨格のみの間は、tsconfig.json / typescript /
# pnpm が無いケースを exit 0（通知のみ）で通し、スキャフォールド中の開発をブロックしない。
set -euo pipefail

if [[ "${AI_OFFICE_SKIP_TYPECHECK:-}" == "1" ]]; then
  exit 0
fi

# jq が無い環境ではフェイルオープン（ブロックせず通す）
if ! command -v jq >/dev/null; then
  echo "typecheck-touched: jq が見つからないため検証をスキップしました（fail-open）" >&2
  exit 0
fi

file_path=$(jq -r '.tool_input.file_path // empty')

# .ts / .tsx 以外は対象外
[[ -n "$file_path" ]] || exit 0
case "$file_path" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# 最寄りの package.json から所属 workspace パッケージを特定
dir=$(dirname "$file_path")
pkg_dir=""
while [[ "$dir" != "/" && "$dir" != "." ]]; do
  if [[ -f "$dir/package.json" ]]; then
    pkg_dir="$dir"
    break
  fi
  dir=$(dirname "$dir")
done

if [[ -z "$pkg_dir" ]]; then
  echo "typecheck-touched: 所属パッケージ（package.json）が見つからないためスキップ: $file_path"
  exit 0
fi

pkg_name=$(jq -r '.name // empty' "$pkg_dir/package.json")

# --- 骨格状態の検出（M0 スキャフォールド中はブロックしない） ---
if [[ -z "$pkg_name" ]]; then
  echo "typecheck-touched: $pkg_dir/package.json に name が無いためスキップ"
  exit 0
fi
if [[ ! -f "$pkg_dir/tsconfig.json" ]]; then
  echo "typecheck-touched: $pkg_dir に tsconfig.json が無いためスキップ（骨格状態）"
  exit 0
fi
if ! command -v pnpm >/dev/null; then
  echo "typecheck-touched: pnpm が見つからないためスキップ（corepack enable で導入可能）"
  exit 0
fi
if [[ ! -x "$pkg_dir/node_modules/.bin/tsc" && ! -x "$root/node_modules/.bin/tsc" ]]; then
  echo "typecheck-touched: typescript が未インストールのためスキップ（骨格状態）"
  exit 0
fi
# --- ここまで骨格対応。パッケージが整い次第、以下が実効化する ---

if ! output=$(cd "$root" && pnpm --filter "$pkg_name" exec tsc --noEmit --incremental 2>&1); then
  {
    echo "typecheck-touched: パッケージ $pkg_name の型検査に失敗。tsc 出力（先頭 30 行）:"
    printf '%s\n' "$output" | head -30
  } >&2
  exit 2
fi

exit 0
