---
name: feedback-fastmode-masks-slowmode-bugs
description: every scene.ts test in the repo used to run only fastMode:true/false pairs incidentally — always add a dedicated slow-mode (fastMode:false) regression test for any bug involving multi-tick walk state, or it will pass while production (non-e2e) stays broken
metadata:
  type: feedback
---

**Rule**: when a bug (or a new feature) involves a `RuntimeCharacter` that walks over
multiple ticks (anything using `character.path` / `startWalk` / `startLeave` in
`scene.ts`), write at least one regression test with `fastMode: false` that advances ticks
incrementally and asserts state **mid-walk**, not just at rest. Don't rely on `fastMode: true`
tests alone, even if they're faster to write and the majority of the existing suite uses them.

**Why**: found via office-qa review of M1-4b (`apps/web/game/scene.ts`
`reconcileSubagents`/`spawnSub`) — a same-session `Task → SubagentStop → Task` sequence
reused the spawn key (`` `${sessionId}:${stack.length}` ``) when the second `Task` arrived
before the first child's leave-walk had finished. In `fastMode: true`, `startWalk` calls
`arrive()` synchronously, so a leaving character is always fully removed (and its key freed)
before the next spawn can reuse it — **the bug is structurally unreachable in fast-mode**.
Every subagent test in `scene.test.ts` at the time used `fastMode: true` (chosen because
it's less verbose — no `advanceMany` bookkeeping needed), so 229 green tests coexisted with
a production-path (`fastMode: false`, the default — `?e2e=1` is the only thing that flips
it to `true`) tile-reservation leak that would fire on every SSE-restore burst. See
[[project_m1_4b_subagent_spawn_and_tile_allocation]] for the fix (monotonic per-session
spawn-key counter decoupled from LIFO stack length).

**How to apply**: when reviewing or writing scene.ts tests touching walk/leave/spawn
timing, explicitly ask "does this assertion only hold true because fast-mode collapses the
walk into a single synchronous step?" If yes, and the code path in question runs in
production at `fastMode: false`, add a slow-mode sibling test that advances ticks partway
(not to completion) before applying the next event, matching how a real SSE-restore burst
or live event stream actually interleaves ticks and events.
