#!/usr/bin/env bash
# gate-protocol-consumers.sh — protocol 変更時の両系テストゲート【Stop / B 系統・検証 hook】
#
# CLAUDE.md 規約「protocol 変更時は relay/web 両テスト」の機械化（設計書 §2.2）。
# exit 0 = pass / exit 2 = block（stderr が Claude に読まれ自己修正ループに入る）。
#
# 既知の限界: main ブランチ上に直接コミットされた packages/protocol の変更は
# `git diff HEAD`（未コミット分）にも `git diff main...HEAD`（ブランチ差分）にも
# 現れないため検出できない。設計書 §2.2 の仕様どおりであり、/office-develop
# Phase 5 のブランチ運用（feat/... で作業して PR）が前提である。
set -euo pipefail

if ! command -v jq >/dev/null; then
  echo "gate-protocol-consumers: jq が見つからないため検証をスキップしました（fail-open）" >&2
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root"

payload=$(cat)

# --- 1. 無限ループ防止（2 周目は記録して通す） ---
stop_hook_active=$(printf '%s' "$payload" | jq -r '.stop_hook_active // false')
if [[ "$stop_hook_active" == "true" ]]; then
  echo "gate-protocol-consumers: stop_hook_active のため未解決のまま通過（$(date -Iseconds)）" \
    >> .claude/hooks/verify/last-failure.log
  exit 0
fi

# --- 2. protocol に変更が無ければ何もしない ---
# 未追跡ファイル（新規追加した protocol のソース）も git diff には現れないため
# git status --porcelain も併せて見る。
changed=$(
  {
    git diff --name-only HEAD || true
    git diff --name-only main...HEAD || true
    git status --porcelain | awk '{print $NF}' || true
  } | sort -u
)
if ! printf '%s\n' "$changed" | grep -q '^packages/protocol/'; then
  exit 0
fi

# --- 2.5. 対象パッケージが解決できることを確認（fail-open の防止） ---
# パッケージ名の変更や workspace の破損で --filter が 0 件マッチになると、
# テストが 1 件も走らないまま exit 0 になり保護が無言で外れる。
# 注意: pnpm は未マッチ時に "No projects matched the filters" を stdout へ出して
# exit 0 で終わるため、空文字判定では検出できない。"ok" との完全一致で判定する。
for pkg in @ai-office/relay web; do
  if [[ "$(pnpm --filter "$pkg" exec node -e 'process.stdout.write("ok")' 2>/dev/null)" != "ok" ]]; then
    echo "gate-protocol-consumers: パッケージ '$pkg' を解決できません（--filter が 0 件マッチ）。" >&2
    echo "workspace の構成かパッケージ名を確認してください。protocol 変更の保護を無言で外さないため block します。" >&2
    exit 2
  fi
done

echo "gate-protocol-consumers: packages/protocol の変更を検出。relay / web の両テストを実行します"

# --- 3. 両系テスト ---
# `--` の後の `--run` はスクリプト（vitest）へ渡す。各パッケージの test script は
# 既に `vitest run` だが、将来 watch モードに変えられても Stop hook が
# 無限待機しないよう明示的に渡す（設計書 §2.2）。
failed=0
report=""

if ! relay_out=$(pnpm --filter @ai-office/relay test -- --run 2>&1); then
  failed=1
  report+=$'\n=== @ai-office/relay のテスト失敗 ===\n'
  report+=$(printf '%s\n' "$relay_out" | tail -30)
fi

if ! web_out=$(pnpm --filter web test -- --run 2>&1); then
  failed=1
  report+=$'\n=== web のテスト失敗 ===\n'
  report+=$(printf '%s\n' "$web_out" | tail -30)
fi

if [[ "$failed" -ne 0 ]]; then
  {
    echo "packages/protocol を変更した場合、relay と web の両方のテストが green である必要があります"
    echo "（CLAUDE.md 開発規約 2 / 設計書 §2.2）。失敗内容:"
    printf '%s\n' "$report"
  } >&2
  exit 2
fi

echo "gate-protocol-consumers: relay / web ともに green"
exit 0
