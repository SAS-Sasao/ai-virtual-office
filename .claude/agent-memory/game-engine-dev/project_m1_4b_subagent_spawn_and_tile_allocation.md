---
name: project-m1-4b-subagent-spawn-and-tile-allocation
description: M1-4b design — office-state.ts activeSubagents LIFO + attribution-overwrite fix (pre_tool AND post_tool), scene.ts child "sub" character spawn with unified non-overlapping tile allocation (visitor+sub share one allocator), debug.ts pendingNotifications sourced from OfficeState not RuntimeCharacter
metadata:
  type: project
---

M1-4b closed the subagent-routing gap noted in [[project_m1_4a_scene_claim_visitor_design]]
(design memo rev.3, human-approved after 2 review cycles). Key facts for future cycles
touching `office-state.ts`/`scene.ts`/`debug.ts`:

**subagent is not a separate session**: it has no independent `session_id`. Its
attribution (org/dept/role) and `subagentType` ride on the **parent session's**
`PreToolUse(Task)` event (regla 3 attribution). `SubagentStop` also arrives on the parent
session, with no task id — so there is no way to exactly pair a `subagent_stop` with the
`Task` call it closes. The whole design leans on this constraint.

**office-state.ts**: `SessionCharacter.activeSubagents: SubagentEntry[]` is a LIFO stack.
`pre_tool` with `toolName === "Task"` pushes an entry built from *that event's own*
org/dept/role/subagentType. `subagent_stop` pops the last entry (`.slice(0, -1)`, safe
no-op if empty). **Attribution-overwrite bug (found + fixed this cycle, red-tested)**:
both `pre_tool(Task)` *and* `post_tool(Task)` carry the subagent's own attribution, not
the parent's — the pre-existing `attributionPatch(ev)` call must be skipped entirely for
both event types on Task, or the parent session's org/dept/role gets clobbered by
whichever subagent it last spawned. (rev.2 of the design memo only caught the pre_tool
half; rev.3's second review round caught post_tool too — a good example of why "apply the
same fix to all code paths carrying the same signal" is worth double-checking explicitly
rather than trusting the first fix location found.)

**scene.ts child spawn**: `reconcileSubagents(session)` diffs `session.activeSubagents.length`
against a per-session stack of previously-spawned child keys (`subStackBySession: Map<sessionId, string[]>`).
Growth spawns new `kind: "sub"` `RuntimeCharacter`s; shrinkage despawns the *most recently
spawned* one (LIFO by spawn order, **not** by which dept it's actually working in — a
concurrent multi-dept-Task session can show the wrong-looking child leave first; this is a
documented, accepted limitation, not a bug, since exact pairing is structurally
impossible). Spawn key = `` `${sessionId}:${seq}` `` where `seq` comes from a **separate
per-session monotonic counter (`subSpawnSeqBySession`, never decremented on pop)** —
**correction (office-qa M1-4b finding 1, fixed 2026-07-26)**: deriving the key from
`stack.length` at push time is NOT safe in slow-mode (non-`fastMode`): if a respawn
(growth) happens before a previous same-position child's leave-walk finishes (shrink
already popped it off `stack` but `advance()` hasn't ticked it to `removeCharacter()` yet),
the reused key overwrites the still-walking-out child in `subsByKey`, orphaning it
(unreachable from `getRuntimeCharacters()`, never ticked again, its `reservedTile` leaks
forever). `index = stack.length` is still used (unchanged) for indexing into
`entries[index]`, which remains correct — only the *key string* was decoupled from it.

**Two despawn paths, both required**: ① LIFO pop via `subagent_stop` ② when the *parent*
session disappears from the `OfficeState` snapshot (session_end / prune), **all** of its
children must be despawned too — mirrors the existing visitor-cleanup loop in
`syncFromOffice` almost exactly (same "walk to exit, remove on arrival" pattern via a
now-shared `startLeave()`, previously named `startVisitorLeave()`). Forgetting path ② was
the HIGH-severity finding from the second design review round — it's easy to implement
only the LIFO path because it's the "interesting" one and miss that parent-vanishes is a
second, structurally different trigger.

**Unified non-overlapping tile allocation (visitor + sub share one allocator)**: both
kinds resolve their destination via the same `resolveDestination(floor, primaryRoom)` →
tries `primaryRoom` first (visitor: always the reception room; sub: its own attributed
dept's room), falls back to the reception room if primary is full/missing, falls back to
the floor entrance (unreserved) as the last resort. Candidate tiles within a room come
from `roomTileCandidates()`: **`roomInteriorAnchor()` is always the first candidate**,
*then* the rest of the interior tiles in row-major (y, then x) order, desks always
excluded. **Why the anchor-first quirk matters**: a pre-existing AC-5 test asserted the
*first* visitor to arrive at reception lands exactly on the room's center anchor tile
(`(14,10)` in the `REAL_SHAPE_FLOOR` fixture) — a naive "pure row-major" candidate list
would have broken that assertion (existing tests must never regress, tests.md rule 1).
Occupancy is tracked in `occupiedTilesByRoomKey: Map<"org:roomId", Set<"x,y">>`, reserved
at spawn time and released in `removeCharacter()` (i.e. when the character is actually
removed from the scene — not when it merely *starts* leaving), stored per-character as
`reservedRoomKey`/`reservedTile`.

**Test-writing gotcha (cost real debugging time)**: in any test scenario, a session with
*no* dept/role attribution becomes a **visitor** itself (existing M1-4a behavior) and
therefore *also* consumes a reception tile — this collided with tile-allocation
expectations in subagent-fallback tests (e.g. "unattributed Task subagent routes to
reception anchor" failed because the *parent session itself*, being unattributed, walked
to reception first and took the anchor tile before its child subagent did). **Fix**: when
a test wants to isolate subagent/visitor tile-allocation behavior, give the parent session
full attribution matching a roster character (so it claims instead of spawning a
competing visitor) unless the test is specifically about parent-is-also-a-visitor
interaction. For an isolated fixture with no existing roster (e.g. a purpose-built small
room for overflow tests), you must add minimal distinct roster `Character`s so each parent
session can claim (two sessions can't share one role — the second becomes a visitor per
existing M1-4a claim-conflict rules).

**debug.ts pendingNotifications (AC-5, explicitly authorized semantic change)**: switched
from counting `RuntimeCharacter.state === "waiting"` to `scene.getWaitingSessionCount()`
(a count `scene.ts` derives directly from the `OfficeState` snapshot in `syncFromOffice`,
independent of any character's visual/walk state). **Why**: a visitor session that
receives a `notification` event while still mid-walk toward reception has
`session.state === "waiting"` in `OfficeState` immediately, but its `RuntimeCharacter.state`
stays `"walk"` (the real state is parked in `onArriveState` until arrival) — the old
character-state-counting implementation under-reported the badge/panel count during that
walk window. `buildDebugState(scene, runtimeLayout)`'s signature did not change.

**Scene needed a minimal floor-scoping addition not explicitly itemized in the design
memo's bullet list**: `setPointer()`'s hit-test needs to know which floor is currently
displayed (to convert canvas x/y → tile coords and to avoid false-positive hits against
off-screen floors' characters at coincidentally-matching tile coordinates). Added
`scene.setFloor(org)` / `scene.getCurrentFloorOrg()` (mirrors the pre-existing
`RendererHandle.setFloor`, defaults to `runtimeLayout.floors[0]`, no-op on unknown org).
This wasn't itemized under scene.ts's bullet list in the memo (which only explicitly
scoped `focusSessionId`/`setPointer`/hit-test), but was inferred as a structural
prerequisite from AC-3's validation text ("`setFloor` で scene/renderer のフロアが切り替わる").
**How to apply**: when a design memo's AC validation text implies an API surface that a
bullet-listed feature can't function correctly without, it's reasonable to add the minimal
version of it and flag the addition explicitly in the final report rather than either (a)
silently skipping correctness or (b) over-building a feature that's actually another
subagent's scope (here, the floor-tab UI itself stayed ui-dev's job — only the
`Scene`-side plumbing was added).
