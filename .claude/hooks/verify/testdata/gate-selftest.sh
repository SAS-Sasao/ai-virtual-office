#!/usr/bin/env bash
# gate-selftest.sh — gate-test-weakening.sh / gate-e2e-smoke.sh の exit code 回帰テスト。
#
# AC-7（弱体化 diff で exit 2 / 正常 diff で exit 0）と AC-8 の軽量部分
# （stop_hook_active・apps/web 無変更・chromium 未 install で exit 0）を、サーバを
# 起動せず決定論的に検証する。@smoke の実 fail→exit 2 は重いため本 selftest には
# 含めず、検証時に手動で確認する（設計メモ参照）。
#
# 走査 glob（*.spec.ts / *.test.ts）の外（testdata/*.sh, *.diff）に置くため、
# gate-test-weakening 自身の対象にならない。
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
verify_dir="$(dirname "$here")"
repo_root="$(cd "$verify_dir/../../.." && pwd)"
weakening="$verify_dir/gate-test-weakening.sh"
e2e="$verify_dir/gate-e2e-smoke.sh"

fail=0
run_case() {
  # run_case <label> <expected_exit> <cmd...>
  local label="$1" expected="$2"
  shift 2
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  if [[ "$actual" -eq "$expected" ]]; then
    echo "[PASS] $label (exit $actual)"
  else
    echo "[FAIL] $label (expected $expected, got $actual)"
    fail=1
  fi
}

echo "=== gate-test-weakening ==="
run_case "weakening-skip.diff → block" 2 \
  env AI_OFFICE_WEAKENING_DIFF_FILE="$here/weakening-skip.diff" bash -c "echo '{}' | '$weakening'"
run_case "weakening-expect-drop.diff → block" 2 \
  env AI_OFFICE_WEAKENING_DIFF_FILE="$here/weakening-expect-drop.diff" bash -c "echo '{}' | '$weakening'"
run_case "weakening-none.diff → pass" 0 \
  env AI_OFFICE_WEAKENING_DIFF_FILE="$here/weakening-none.diff" bash -c "echo '{}' | '$weakening'"
run_case "stop_hook_active=true → pass even with weakening diff" 0 \
  env AI_OFFICE_WEAKENING_DIFF_FILE="$here/weakening-skip.diff" bash -c "echo '{\"stop_hook_active\":true}' | '$weakening'"
run_case "missing diff file → block" 2 \
  env AI_OFFICE_WEAKENING_DIFF_FILE="$here/does-not-exist.diff" bash -c "echo '{}' | '$weakening'"

echo "=== gate-e2e-smoke ==="
run_case "stop_hook_active=true → pass" 0 \
  env CLAUDE_PROJECT_DIR="$repo_root" bash -c "echo '{\"stop_hook_active\":true}' | '$e2e'"

# apps/web 無変更（一時空 git リポジトリ）→ pass
tmp_repo="$(mktemp -d)"
(
  cd "$tmp_repo"
  git init -q
  git config user.email t@example.com
  git config user.name t
  git commit --allow-empty -q -m init
)
run_case "no apps/web diff → pass" 0 \
  env CLAUDE_PROJECT_DIR="$tmp_repo" bash -c "echo '{}' | '$e2e'"
rm -rf "$tmp_repo"

# chromium 未 install（存在しない browsers path）→ skip pass
run_case "chromium absent → skip pass" 0 \
  env CLAUDE_PROJECT_DIR="$repo_root" PLAYWRIGHT_BROWSERS_PATH="/nonexistent-ms-playwright" bash -c "echo '{}' | '$e2e'"

if [[ "$fail" -ne 0 ]]; then
  echo "=== gate-selftest: FAIL ==="
  exit 1
fi
echo "=== gate-selftest: PASS ==="
exit 0
