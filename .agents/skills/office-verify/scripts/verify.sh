#!/usr/bin/env bash
# verify.sh — office-verify 停止条件スクリプト（M0 骨格版）
#
# exit 0 = 合格 / 非 0 = 不合格。LLM の目視判断を挟まず、このスクリプトの
# exit code だけで合否を決める（設計書 §3.1 / 原則 P4）。
#
# 実装済みステップが全て通れば exit 0。未実装（M1 予定）のステップは
# TODO として明示し、合否には含めない。
set -euo pipefail

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
cd "$root"

fail=0

echo "=== office-verify (M0 骨格版) ==="

# --- Step 1: pnpm と依存関係の確認 -------------------------------------------
if ! command -v pnpm >/dev/null; then
  echo "[FAIL] pnpm が見つからない（corepack enable && corepack prepare pnpm@9.0.0 --activate で導入）" >&2
  exit 1
fi
echo "[step] pnpm install"
if ! pnpm install; then
  echo "[FAIL] pnpm install が失敗" >&2
  exit 1
fi

# --- Step 2: 各 workspace パッケージの build / typecheck ----------------------
# パッケージに該当スクリプトが定義されている場合のみ実行する（骨格状態では 0 件で通過）
ran=0
for manifest in apps/*/package.json packages/*/package.json; do
  [[ -f "$manifest" ]] || continue
  pkg_name=$(jq -r '.name // empty' "$manifest")
  [[ -n "$pkg_name" ]] || continue
  for script in build typecheck; do
    if [[ "$(jq -r --arg s "$script" '.scripts[$s] // empty' "$manifest")" != "" ]]; then
      echo "[step] pnpm --filter $pkg_name run $script"
      ran=$((ran + 1))
      if ! pnpm --filter "$pkg_name" run "$script"; then
        echo "[FAIL] $pkg_name の $script が失敗" >&2
        fail=1
      fi
    fi
  done
done
if [[ "$ran" -eq 0 ]]; then
  echo "[note] build/typecheck を定義した workspace パッケージがまだ無い（M0 骨格状態）"
fi

# --- Step 3 以降: M1 で実装 ---------------------------------------------------
# TODO(M1): Relay をバックグラウンド起動する（packages/relay）
# TODO(M1): fixture イベントを注入する（POST /test/inject、fixtures/e2e/*.jsonl）
# TODO(M1): Debug State API（window.__OFFICE_DEBUG__.getState()）で描画状態を assert する
echo "[note] Relay 起動 / fixture 注入 / Debug State API assert は M1 で実装（未実装・合否対象外）"

if [[ "$fail" -ne 0 ]]; then
  echo "=== office-verify: FAIL ===" >&2
  exit 1
fi
echo "=== office-verify: PASS ==="
exit 0
