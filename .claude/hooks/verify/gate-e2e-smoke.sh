#!/usr/bin/env bash
# gate-e2e-smoke.sh — @smoke E2E 実行【Stop / B 系統・検証 hook】
#
# 設計書 §2.2 / §5.2。apps/web（game 含む）に変更があるときだけ @smoke を実行し、
# fail なら exit 2 でブロックする。無関係変更・E2E 未整備・chromium 未 install の
# ときは早期 exit 0（silent skip ではなく skip 理由を stderr に出す）。
#
# 注意（結線順序・設計メモ rev.2 finding 4）: settings.json の Stop 配列への結線は
# @smoke が green かつ chromium が導入済みになった後の Phase 5 で行う。本スクリプトは
# presence ガードを内蔵するため未導入環境でも安全（block しない）だが、結線は
# その順序を守ること。
set -euo pipefail

if ! command -v jq >/dev/null; then
  echo "gate-e2e-smoke: jq が見つからないため検証をスキップしました（fail-open）" >&2
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root"

payload=$(cat)

# --- 1. 無限ループ防止（2 周目は通す） ---
stop_hook_active=$(printf '%s' "$payload" | jq -r '.stop_hook_active // false')
if [[ "$stop_hook_active" == "true" ]]; then
  exit 0
fi

# --- 2. apps/web に変更が無ければ何もしない ---
# gate-protocol-consumers.sh と同じ検出方式（未追跡ファイルも拾うため
# git status も併用。git のエラー＝main 未作成等は正当な非対象状態）。
changed=$(
  {
    git diff --name-only HEAD || true
    git diff --name-only main...HEAD || true
    git status --porcelain | awk '{print $NF}' || true
  } | sort -u
)
if ! printf '%s\n' "$changed" | grep -q '^apps/web/'; then
  exit 0
fi

# --- 3. playwright / chromium presence ガード（未導入なら skip・exit 0） ---
if ! pw_version=$(pnpm --filter web exec playwright --version 2>&1); then
  echo "gate-e2e-smoke: playwright 未導入のため @smoke を skip しました（$pw_version）" >&2
  exit 0
fi
browsers_dir="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if ! compgen -G "$browsers_dir/chromium-*" >/dev/null && ! compgen -G "$browsers_dir/chromium_headless_shell-*" >/dev/null; then
  echo "gate-e2e-smoke: chromium ブラウザ未 install のため @smoke を skip しました（npx playwright install chromium で導入）" >&2
  exit 0
fi

# --- 4. @smoke 実行（60 秒予算） ---
echo "gate-e2e-smoke: apps/web の変更を検出（playwright $pw_version）。@smoke を実行します"
run_smoke() {
  if command -v timeout >/dev/null; then
    timeout 60 pnpm --filter web e2e:smoke
  else
    pnpm --filter web e2e:smoke
  fi
}

if ! smoke_out=$(run_smoke 2>&1); then
  {
    echo "gate-e2e-smoke: @smoke が失敗しました（Phase 4・設計書 §5.3 ループ B の 3 分類で Phase 2 へ）。"
    echo "--- 失敗テスト ---"
    printf '%s\n' "$smoke_out" | grep -E '✘|✗|failed|Timed out|Error:|passed' | head -12 || true
    echo "--- 出力末尾 ---"
    printf '%s\n' "$smoke_out" | tail -5
  } >&2
  exit 2
fi

echo "gate-e2e-smoke: @smoke green"
exit 0
