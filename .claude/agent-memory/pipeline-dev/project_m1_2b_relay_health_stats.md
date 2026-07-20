---
name: m1-2b-relay-health-stats
description: GET /health に receivedCount/lastEventAt を追加した際の設計判断(なぜ/test/injectをdoctorに使わないか、DIパターン、toEqual拡張の作法)
metadata:
  type: project
---

M1-2b（`feat/2026-07-21-m1-2b-setup-cli` ブランチ、`packages/relay/` のみ担当。`packages/cli` は別担当が並行作業）。設計メモ rev.3（人間承認済み）「packages/relay — /health の拡張」節に従い TDD で実装。68 → 76 テスト green（既存 68 は無改修、`GET /health` の 1 テストのみ期待値に新フィールドを追加）。typecheck/build とも exit 0。

**なぜ `POST /test/inject` を doctor のイベント到達確認に使わなかったか**: rev.1 の設計は `/test/inject` で疎通確認する想定だったが、それは `AI_OFFICE_TEST_MODE=1` 限定で通常運用では 404 になり、かつ受理したイベントを実際に下流（web の ingest/DB）へ転送してしまう副作用がある。doctor は通常運用の Relay に対して副作用ゼロで到達確認したいので、`/health` に**プロセス内カウンタ**（`receivedCount`/`lastEventAt`）を足す方式に変更された。この一連の経緯は `packages/cli` 側の doctor 実装判断にも波及するため、pipeline-dev がここを変える際は cli 側の期待（AC-7/AC-7b/AC-13、`--forward` を使い捨て sink に向けて実行する等）を壊さないよう `docs/design/` の設計メモを確認すること。

**`stats.ts` は `seq.ts`（[[m1-2a-relay-persistence]]）と同じ DI パターンで作った**: `createStatsCounter(): StatsCounter`（`record(ts)` / `snapshot()`）をクロージャで実装し、`CreateServerOptions.stats` として注入可能にした（既定値は `createStatsCounter()`）。設計メモが明示的に「カウンタは createServer の依存として注入可能にする」と要求していたため、内部変数を直接持たずこの形にした。永続化はしない（Relay 再起動でリセットされる前提。設計メモも「時間窓を設けても実質プロセス内カウンタに縮退するので閾値は設けない」と明記）。

**カウント条件は「正規化成功のみ」「forward の成否に非依存」**: `/hooks/:event` ハンドラで `normalizeHookEvent` が非 null を返した直後、`forward()` 呼び出しの**前**に `stats.record(ts)` する。理由: forward が失敗しても RetryBuffer が再送を担い hooks 到達自体はここで確定しているため。逆に `POST /test/inject` は別ハンドラなので自然にカウントされない（意図どおり、コードを分ける必要すらなかった）。`GET /health` はカウンタを読むだけで `record` を呼ばないため、閲覧では増えない。

**`now()` の二重呼び出しを避けた**: 元コードは `normalizeHookEvent(raw, now())` と直書きだったが、`stats.record()` にも同じ ts を渡す必要があるため `const ts = now(); normalizeHookEvent(raw, ts); ...; stats.record(ts);` に変更。テストでは `now: () => NOW` 固定なので実害はないが、本番の `Date.now()` でも同一イベント内の時刻源を一致させる意味で正しい。

**既存 `server.test.ts` の `toEqual` は「緩和」ではなく「フィールド追加」で対応**: `GET /health` のテストは網羅的 `toEqual` を使っていたため、`toMatchObject` へ緩和せず、期待値オブジェクトに `receivedCount: 0, lastEventAt: null` を追記する形で修正した（他のテストルール `.claude/rules/tests.md` の「assertion 弱体化の禁止」とも整合）。M1-2a のときと同様、protocol/relay のフィールド拡張は「既存 toEqual に新フィールドを足す」が正解で、緩和は禁止という運用が定着している。

関連: [[m1-2a-relay-persistence]] [[m1-1-relay-creation]]
