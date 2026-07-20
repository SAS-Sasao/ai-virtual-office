---
name: ingest-stream-reliability-m0
description: apps/web/app/api/ingest, api/stream の信頼性まわりの実装判断（M0）と bus.ts の globalThis シングルトン理由
metadata:
  type: project
---

M0 で `apps/web/app/api/ingest/route.ts` / `apps/web/app/api/stream/route.ts` / `apps/web/lib/bus.ts` を実装した際の判断。

**Why:** NFR-2（hooks は Claude Code の動作を絶対にブロックしない）を受け側でも徹底するため、`POST /api/ingest` は `req.json()` の parse 失敗・`normalizeHookEvent` 内の想定外エラーの両方を try/catch で包み、**常に 200** を返す（`{ok:true, ignored:true|false}`）。exit code 云々は hooks コマンド側の話だが、受け側が 4xx/5xx を返すと `curl --max-time 2` がリトライ等で余計な待ちを生む可能性を避ける意図。

**How to apply:**
- ingest route を変更するときも「例外を投げて非 200 を返すパス」を絶対に作らない。新しい失敗モードを追加したら必ず try/catch の内側に置く。
- `lib/bus.ts` は `globalThis.__aiOfficeEventBus__` にリスナー Set を保持するシングルトンパターン。Next.js dev の Fast Refresh でモジュールが再評価されても購読者が消えない・二重登録されないようにするための設計（pixel-agents 由来ではなく本プロジェクト独自）。テストで bus を使うときはグローバル状態がテスト間で共有される点に注意（vitest はデフォルトでテストファイルごとに新しい module registry なので通常は問題にならないが、同一ファイル内の複数テストでは購読リークに注意）。
- `/api/stream` は `dynamic = 'force-dynamic'` 必須（App Router のデフォルトの静的最適化/キャッシュに巻き込まれると SSE が固まる）。ヘッダは `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no`（プロキシのバッファリング対策、pixel-agents 分析時からの既知の落とし穴）。
- 動作確認は `next dev -p 3001` を一時起動して curl で実施済み（ingest: 不正 JSON / 未知イベント / 正常系すべて 200、stream: hello → publish したイベントが SSE で届く、ヘッダも仕様通り）。E2E 自動化は M0 スコープ外（design memo 記載通り）。
