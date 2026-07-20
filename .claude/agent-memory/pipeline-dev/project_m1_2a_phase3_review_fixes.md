---
name: m1-2a-phase3-review-fixes
description: Phase3レビューmedium2件(buffer.tsのdrain再入・events.tsのrestore順序)修正時の技法と、next buildが本番DBを汚す潜在バグの発見ログ
metadata:
  type: project
---

M1-2a の Phase 3 レビュー（pass 0.91、medium 2件）を受けて `packages/relay/src/buffer.ts` と `apps/web/db/events.ts` のみを対象に TDD で修正した記録。[[m1-2a-relay-persistence]] [[m1-2a-web-db-persistence]] の続き。137テスト green（133 + buffer 1 + events 3）。

**drain() の再入バグ（buffer.ts）**: `scheduleRetry` のタイマー callback が `retryScheduled=false` を drain() 呼び出し**前**に立てるため、drain が forward を await 中に別の enqueue が発生すると「まだ retryScheduled=false に見える」ので 2 本目のタイマーが取れてしまい、それが発火すると drain() が並行して起動し同じ `queue[0]` を二重 forward する。**修正は `let draining` フラグを追加して drain() 冒頭で `if (draining) return`、`finally` で false に戻すだけ**（`retryScheduled` の解除タイミング自体は変えていない＝2本目のタイマーが予約されること自体は許容し、その「効果」だけを潰す設計）。

**この手のバグを再現するテストの書き方（sleep 無し・timeout も回避）**: `fireNext()` のように `fn()` を毎回**完全に await するヘルパーでは構造上この経路を踏めない**（レビュアー指摘どおり）。forward に「外部から手動で resolve できる Promise」を返させ、意図的に「1本目の drain が forward を await 中で止まっている」状態を作ってから 2本目のタイマーを発火させる必要がある。**最初 `await timer.fireNext()` で2本目を待とうとしたら 5秒 timeout でテストが落ちた**（バグありコードだと再入した drain の forward 呼び出しが誰にも resolve されず永久に pending になるため）。**`void next.fn()` として待たずに fire し、`await Promise.resolve()` を2回挟むだけ**にしたら、バグ再現時に「二重 forward が起きた」という同期的な副作用（カウンタ増加）だけを一瞬で観測でき、timeout ではなく `expected 2 to be 1` のクリーンな assertion failure に変わった。**re-entrancy バグの red は "timeout" と "assertion failure" の両方があり得るが、後者の方が圧倒的にデバッグしやすい・CI 時間も食わない**ので、被疑コードが「誰にも resolve されない Promise を作りうる」構造なら、確認用の fire は必ず non-blocking（`void`）にしてから短い microtask flush で観測すること。

**restore の順序判定バグ（events.ts）**: `loadRecentSessions` が SQL の `orderBy(ts, id)` で「最後に走査した行を最新とみなす」実装だったため、**同一 ts で seq が逆順に insert される**（N-2 で head-of-line を撤回した結果、順序が入れ替わって ingest に届くのは正常な入力形状）と、insert 順（id）が seq より優先されてしまい古い方が復元される。**修正は SQL の orderBy には頼らず、`compareOrder`（apps/web/game/office-state.ts と同一規則: 両者が seq を持つときのみ seq 比較、欠ければ ts 比較）で Map への上書き可否を判定する**方式に変更。SQL の orderBy はテスト決定論性のための補助的な走査順のままで構わない（最終判定は JS 側の compareOrder が握るため）。

**同一規則の「再実装」を守る制約**: 今回は `packages/relay/src/buffer.ts` / `buffer.test.ts` / `apps/web/db/events.ts` / `events.test.ts` の**4ファイルのみ**しか触れない制約だったため、`office-state.ts` から `compareOrder` を export して import する（共有）という選択肢は**取れなかった**。coordinator の指示どおり「再実装するなら同一規則であることをテストで固定する」を採用し、events.ts 内に private な `compareOrder`/`OrderKey` を再実装した上で、seq 逆順・片方 seq 欠落・両方 seq 欠落の3パターンをテストで固定した。**次に office-state.ts 側の compareOrder を変更する担当は、events.ts 側のこのコピーも同じルールに追従させる必要があることに気づけるよう、両ファイルの doc comment に互いへの参照を残してある**（実ファイルは変更していないため import による強制はできていない＝ドリフトのリスクは残る）。

**【重要・未対応の発見】`NEXT_DIST_DIR=... next build` が本番 `~/.ai-office/events.db` を実際に作成する**: このラウンドの検証で（`AI_OFFICE_DB_PATH` を設定せずに）`next build` を一度実行したところ、`~/.ai-office/events.db`（20KB、テーブル作成済み）が実際に生成された。原因は未特定だが、Next.js の "Collecting page data" フェーズが `/api/ingest`（`export const dynamic = "force-dynamic"` を付けていない）を静的解析のために実際に呼び出し／評価し、`getDb()` の既定パス解決（`resolveDbPath()` → `~/.ai-office/events.db`）に到達している可能性が高い。**この修正ラウンドは `apps/web/db/events.ts` 以外の apps/web ファイル（route.ts・client.ts 含む）を触れない制約だったため未対応**。次に `apps/web/app/api/ingest/route.ts` か `apps/web/db/client.ts` を触る担当は、①`ingest/route.ts` に `export const dynamic = "force-dynamic"` を追加する、②`.claude/skills/office-verify/scripts/verify.sh` や CI の `next build` 実行時に `AI_OFFICE_DB_PATH` を必ず mktemp 配下に設定する、のいずれか（両方が望ましい）で塞ぐこと。今回は検証後に `rm -f ~/.ai-office/events.db` で手動クリーンアップ済み。

関連: [[m1-2a-relay-persistence]] [[m1-2a-web-db-persistence]]
