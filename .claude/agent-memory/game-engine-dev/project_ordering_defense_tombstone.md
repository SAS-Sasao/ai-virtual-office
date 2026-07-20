---
name: project-ordering-defense-tombstone
description: OfficeState.applyEvent gained seq/ts ordering defense + tombstone in M1-2a; ordering guarantees for the whole pipeline are intentionally consolidated here, not in relay
metadata:
  type: project
---

As of the M1-2a persistence cycle (design memo rev.3, human-approved), `apps/web/game/office-state.ts`
implements out-of-order defense in `applyEvent`: events older than the currently held
watermark (compared by `seq` when both sides have it, else by `ts`) are discarded, and
`session_end` no longer does a bare `sessions.delete()` — it writes a tombstone
(`{ seq, ts }` watermark) to a separate `tombstones` map so a late-arriving stale event
can't resurrect an ended session. Tombstones are cleared by `prune(now)` after
`PRUNE_TIMEOUT_MS` (10 min, now `export`-ed from `office-state.ts`).

**Why:** `packages/relay` gained a resend buffer in the same cycle (M1-2a rev.3, finding
N-2) for events accumulated while the web app was down. Reviewers initially proposed
head-of-line blocking in the relay buffer to preserve ordering, but that was rejected
(would violate NFR-1's "under 1s latency" for new events waiting behind a stalled
buffer). The approved design instead consolidates *all* ordering guarantees on the
consumer side (`office-state.ts`) and lets relay always send new events immediately,
appending failed sends to a FIFO buffer that drains on reconnect without blocking new
traffic. This means `office-state.ts` is now the single place responsible for handling
out-of-order delivery for the entire pipeline — relay/db do not do their own ordering.

**How to apply:** Don't reintroduce ordering assumptions elsewhere in `game/` (e.g.
assuming events always arrive with strictly increasing `ts`) — out-of-order and resend
delivery is a normal, expected input shape from here on, not an edge case. If asked to
touch `applyEvent`/`prune` again, preserve the "seq if both sides have it, else ts,
equal-is-idempotent-apply" comparison rule (`compareOrder` in office-state.ts) since it
mirrors the protocol doc comment in `packages/protocol/src/events.ts` verbatim — don't
invent a different rule locally. Also note `PRUNE_TIMEOUT_MS` is exported specifically
so `apps/web/db` (owned by pipeline-dev, out of this agent's scope) can reuse it as the
default `windowMs` for session-restore queries — if the tombstone/prune timeout value
ever needs to change, it changes for both consumers at once, intentionally.
