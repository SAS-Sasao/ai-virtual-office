#!/usr/bin/env bash
# verify.sh — office-verify 停止条件スクリプト（M1-1 版）
#
# exit 0 = 合格 / 非 0 = 不合格。LLM の目視判断を挟まず、このスクリプトの
# exit code だけで合否を決める（設計書 §3.1 / 原則 P4）。
#
# 実装済みステップが全て通れば exit 0。未実装（後続サイクル予定）のステップは
# TODO として明示し、合否には含めない。silent skip はしない。
set -euo pipefail

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
cd "$root"

fail=0

echo "=== office-verify (M1-1 版) ==="

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

# --- Step 2: 各 workspace パッケージの build / typecheck / test ---------------
# build は `pnpm -r run build` に委譲する。pnpm がワークスペースの依存グラフを解決して
# トポロジカル順に実行するため、パッケージが増えても順序が壊れない（glob の辞書順に
# 依存すると、例えば cc-sier-adapter が protocol より先に走って dist 不在で落ちる）。
# typecheck / test はビルド済みの状態で各パッケージを回す。
# web の build は NEXT_DIST_DIR で成果物を分離し、dogfooding の `next dev` が使う
# .next を壊さない（共有すると webpack chunk の不整合で dev サーバが 500 に落ちる）。
#
# なお Next.js は build 時に tsconfig.json / next-env.d.ts を distDir に合わせて
# 自動で書き換える。検証実行で作業ツリーを汚さないよう、前後で退避・復元する。
web_tsconfig="apps/web/tsconfig.json"
web_next_env="apps/web/next-env.d.ts"
restore_web_ts_config() {
  [[ -f "$web_tsconfig.verifybak" ]] && mv -f "$web_tsconfig.verifybak" "$web_tsconfig"
  [[ -f "$web_next_env.verifybak" ]] && mv -f "$web_next_env.verifybak" "$web_next_env"
  return 0
}
[[ -f "$web_tsconfig" ]] && cp "$web_tsconfig" "$web_tsconfig.verifybak"
[[ -f "$web_next_env" ]] && cp "$web_next_env" "$web_next_env.verifybak"
trap restore_web_ts_config EXIT

if grep -q '"build"' packages/*/package.json apps/*/package.json 2>/dev/null; then
  echo "[step] pnpm -r run build（トポロジカル順）"
  if ! NEXT_DIST_DIR=.next-verify pnpm -r run build; then
    echo "[FAIL] pnpm -r run build が失敗" >&2
    fail=1
  fi
fi

ran=0
for manifest in packages/*/package.json apps/*/package.json; do
  [[ -f "$manifest" ]] || continue
  pkg_name=$(jq -r '.name // empty' "$manifest")
  [[ -n "$pkg_name" ]] || continue
  for script in typecheck test; do
    if [[ "$(jq -r --arg s "$script" '.scripts[$s] // empty' "$manifest")" != "" ]]; then
      echo "[step] pnpm --filter $pkg_name run $script"
      ran=$((ran + 1))
      if ! NEXT_DIST_DIR=.next-verify pnpm --filter "$pkg_name" run "$script"; then
        echo "[FAIL] $pkg_name の $script が失敗" >&2
        fail=1
      fi
    fi
  done
done

restore_web_ts_config
trap - EXIT
if [[ "$ran" -eq 0 ]]; then
  echo "[note] typecheck/test を定義した workspace パッケージがまだ無い（骨格状態）"
fi

# --- Step 3: Relay の起動ヘルスチェック --------------------------------------
# ephemeral port（--port 0）で起動するため、dogfooding 中の Relay（既定 4100）と
# 衝突しない。ポート衝突による skip は行わない（silent skip 禁止）。
relay_cli="packages/relay/dist/cli.js"
if [[ -f "$relay_cli" ]]; then
  echo "[step] Relay ヘルスチェック（ephemeral port）"
  relay_log=$(mktemp)
  # 状態ファイル（seq / DB）も一時ディレクトリへ隔離する。既定のままだと検証のたびに
  # dogfooding 中の Relay と共有する ~/.ai-office/relay-seq.json から seq ブロックを
  # 消費してしまう（ポートだけでなく状態ファイルも分離する）。
  relay_state=$(mktemp -d)
  AI_OFFICE_SEQ_PATH="$relay_state/relay-seq.json" \
  AI_OFFICE_DB_PATH="$relay_state/events.db" \
    node "$relay_cli" --port 0 --forward "http://127.0.0.1:1/unused" > "$relay_log" 2>&1 &
  relay_pid=$!
  # shellcheck disable=SC2064
  trap "kill $relay_pid 2>/dev/null || true; rm -f $relay_log; rm -rf $relay_state" EXIT

  relay_port=""
  for _ in $(seq 1 50); do
    relay_port=$(grep -oE 'listening on port [0-9]+' "$relay_log" | grep -oE '[0-9]+$' || true)
    [[ -n "$relay_port" ]] && break
    kill -0 "$relay_pid" 2>/dev/null || break
    sleep 0.1
  done

  if [[ -z "$relay_port" ]]; then
    echo "[FAIL] Relay が起動しなかった（ポート出力を検出できず）" >&2
    cat "$relay_log" >&2
    fail=1
  else
    health=$(curl -s --max-time 3 "http://localhost:${relay_port}/health" || true)
    health_pid=$(printf '%s' "$health" | jq -r '.pid // empty' 2>/dev/null || true)
    if [[ "$health_pid" == "$relay_pid" ]]; then
      echo "[ok] Relay health OK（port=${relay_port} pid=${health_pid}）"
    else
      echo "[FAIL] Relay の /health が起動プロセスと一致しない（期待 pid=${relay_pid} / 応答=${health}）" >&2
      fail=1
    fi
  fi

  kill "$relay_pid" 2>/dev/null || true
  wait "$relay_pid" 2>/dev/null || true
  rm -f "$relay_log"
  rm -rf "$relay_state"
  trap - EXIT
else
  echo "[note] $relay_cli が未ビルドのため Relay ヘルスチェックを実施していない（build 未実行 or 未実装）"
fi

# --- Step 4 以降: 後続サイクルで実装 ------------------------------------------
# TODO(M1-5): fixture イベントを注入する（POST /test/inject、fixtures/e2e/*.jsonl）
# TODO(M1-5): Debug State API（window.__OFFICE_DEBUG__.getState()）で描画状態を assert する
echo "[note] fixture 注入 / Debug State API assert は M1-5（E2E）で実装（未実装・合否対象外）"

if [[ "$fail" -ne 0 ]]; then
  echo "=== office-verify: FAIL ===" >&2
  exit 1
fi
echo "=== office-verify: PASS ==="
exit 0
