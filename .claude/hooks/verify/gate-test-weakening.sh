#!/usr/bin/env bash
# gate-test-weakening.sh — テスト弱体化の検出【Stop / B 系統・検証 hook】
#
# 設計書 §2.2 / .claude/rules/tests.md 規約1（既存テストを skip/削除しない・
# assertion は純増）を機械化する。ブランチ差分の *.spec.ts / *.test.ts に
# `.skip(` / `.only(` / `*.fixme` の追加、または `expect(` の純減があれば
# exit 2 でブロックする（stderr が Claude に読まれ自己修正ループに入る）。
#
# 自己適用トラップ回避（設計メモ rev.2 finding 3）: 診断・自己検証用の diff は
# 走査 glob（*.spec.ts / *.test.ts）の外に置き（testdata/weakening-*.diff）、
# 環境変数 AI_OFFICE_WEAKENING_DIFF_FILE で diff 源を差し替えて exit code を
# 検証する。弱体化パターンを実 test ファイル名でコミットするとゲート自身が
# 以降ずっと誤検出するため禁止。
set -euo pipefail

if ! command -v jq >/dev/null; then
  echo "gate-test-weakening: jq が見つからないため検証をスキップしました（fail-open）" >&2
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

# --- 2. diff 源の決定（env で差し替え可能） ---
diff_text=""
if [[ -n "${AI_OFFICE_WEAKENING_DIFF_FILE:-}" ]]; then
  if [[ ! -f "$AI_OFFICE_WEAKENING_DIFF_FILE" ]]; then
    echo "gate-test-weakening: AI_OFFICE_WEAKENING_DIFF_FILE が指すファイルがありません: $AI_OFFICE_WEAKENING_DIFF_FILE" >&2
    exit 2
  fi
  diff_text=$(cat "$AI_OFFICE_WEAKENING_DIFF_FILE")
else
  # main ref が無い環境（クリーンでない・ブランチ運用前）では fail-open。
  # gate-protocol-consumers と同じく feat/... ブランチ運用が前提（設計書 §2.2）。
  if ! git rev-parse --verify --quiet main >/dev/null; then
    echo "gate-test-weakening: main ref が無いため検証をスキップ（fail-open。ブランチ運用が前提）" >&2
    exit 0
  fi
  diff_text=$(git diff -U0 main...HEAD -- '**/*.spec.ts' '**/*.test.ts')
fi

# --- 3. 追加行の弱体化パターンと expect( 純減を awk で検出 ---
# 出力: "<skip_added 0|1> <expect_added> <expect_removed>"
read -r skip_added expect_added expect_removed < <(
  printf '%s\n' "$diff_text" | awk '
    /^\+\+\+/ { next }
    /^---/    { next }
    /^\+/ {
      line = substr($0, 2)
      if (line ~ /\.skip[[:space:]]*\(/ || line ~ /\.only[[:space:]]*\(/ || line ~ /(test|it|describe)\.fixme/) skip_added = 1
      expect_added += gsub(/expect[[:space:]]*\(/, "&", line)
      next
    }
    /^-/ {
      line = substr($0, 2)
      expect_removed += gsub(/expect[[:space:]]*\(/, "&", line)
      next
    }
    END { printf "%d %d %d\n", skip_added + 0, expect_added + 0, expect_removed + 0 }
  '
)

weakened=0
reasons=""
if [[ "$skip_added" -eq 1 ]]; then
  weakened=1
  reasons+=$'\n- .skip( / .only( / *.fixme の追加を検出（テストを実行対象から外す弱体化）'
fi
if [[ "$expect_removed" -gt "$expect_added" ]]; then
  weakened=1
  reasons+=$'\n- expect( の純減を検出（削除 '"$expect_removed"' 件 > 追加 '"$expect_added"' 件）: assertion が実質的に減っています'
fi

if [[ "$weakened" -ne 0 ]]; then
  {
    echo "gate-test-weakening: テスト弱体化の疑いを検出しました（.claude/rules/tests.md 規約1 / 設計書 §2.2）。"
    echo "既存テストの skip/削除・assertion 純減は禁止です。追加は assertion 純増で行い、"
    echo "意図的な削除が正当な場合はレビューで理由を明示してください。"
    echo "検出内容:${reasons}"
  } >&2
  exit 2
fi

exit 0
