---
name: project-sse-route-idempotent-cleanup-testing
description: How to make Next.js App Router SSE route cleanup idempotent (cancel + enqueue-catch + request.signal abort) and test it deterministically without real ports/sleep
metadata:
  type: project
---

`apps/web/app/api/stream/route.ts` (GET /api/stream, SSE) originally only wired unsubscribe/heartbeat teardown into the `ReadableStream`'s `cancel()` callback. Backend-hardening cycle 2 (design memo "修正C", 2026-08-09) hardened this into three converging cleanup paths, all calling one idempotent `cleanup()` closure (guards with `if (unsubscribe)` / `if (heartbeat !== null)` then nulls them out):
1. `cancel()` (existing — fires when the reader is cancelled)
2. the `catch` blocks around both the live-event `controller.enqueue()` and the heartbeat `controller.enqueue()` (previously did nothing — a client that vanished mid-enqueue leaked the bus subscription and the `setInterval`)
3. `request.signal.addEventListener("abort", cleanup)` — requires changing `GET(): Promise<Response>` to `GET(request: Request): Promise<Response>`, which is a breaking signature change for every existing test call site (`GET()` → `GET(new Request("http://localhost/api/stream"))`).

**Testing this without a real server/port/sleep** (`apps/web/app/api/stream/route.test.ts`):
- Added `listenerCount()` to `apps/web/lib/bus.ts` (returns `getStore().listeners.size`) specifically as a deterministic observation seam for "did unsubscribe actually run" — read it before/after `GET()` and before/after `reader.cancel()` / `abortController.abort()`.
- `reader.cancel()` on `res.body!.getReader()` triggers the `ReadableStream`'s underlying `cancel()` synchronously-awaitable via the returned promise — no `sleep` needed.
- To test the abort-listener path independent of `cancel()`: build the request with `new Request(url, { signal: abortController.signal })`, call `GET(request)`, then `abortController.abort()` — `AbortSignal` dispatches its `abort` event **synchronously**, so `listenerCount()` reflects the cleanup immediately after `.abort()` returns (no await needed).
- To test idempotency (cleanup called twice not throwing): trigger both paths on the same response — `reader.cancel()` then `abortController.abort()` (or vice versa) — and assert no throw + `listenerCount()` stayed at baseline (didn't go negative or double-decrement, which it can't anyway since `Set.delete` is naturally idempotent, but this exercises the `unsubscribe`-nulling guard in `cleanup()` too).
- To verify the heartbeat `setInterval` is actually torn down (not just "harmless because it's guarded"): `vi.spyOn(global, "clearInterval")` (default pass-through mock) before `GET()`, then assert `toHaveBeenCalled()` after `reader.cancel()`. Simpler and more robust than fake timers for this specific assertion — no need to advance time or reason about heartbeat firing cadence.
- Did **not** attempt to directly force the enqueue-catch branch to fire via a still-open reader (would require monkey-patching `ReadableStreamDefaultController.prototype.enqueue` or `TextEncoder.prototype.encode`, which is fragile/order-dependent on internal call counts). The cancel-based and abort-based tests already exercise the shared `cleanup()` closure end-to-end, which is what actually matters.

See also [[project-eventlog-identity-dedup-log-layer]] for the sibling fix in the same cycle (eventlog double-recording on SSE reconnect).
