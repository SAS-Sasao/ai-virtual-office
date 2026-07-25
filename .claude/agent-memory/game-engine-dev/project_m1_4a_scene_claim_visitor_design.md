---
name: project-m1-4a-scene-claim-visitor-design
description: scene.ts's roster-claim vs visitor state machine (M1-4a) — a ghost-duplicate bug found via self-review and its fix, plus a known deferred gap (subagent meeting-room routing)
metadata:
  type: project
---

`apps/web/game/scene.ts` (added M1-4a) reconciles `OfficeState` sessions into two kinds
of `RuntimeCharacter`: **roster** (always-present, one per `characters.json` entry, idle
at their own desk until a session with matching role+dept+org claims them — claim never
triggers walking, since roster never leaves their desk) and **visitor** (any session that
can't claim a roster slot: no attribution, or a second session for an already-claimed
role — walks in from the entrance to the reception room's interior anchor).

**Ghost-duplicate bug (found + fixed during M1-4a, not from an AC)**: a session can start
unattributed (visitor, walking toward reception) and gain matching role/dept/org
*later* via a subsequent event (relay's attributor can resolve attribution mid-session,
e.g. from a later branch-name signal). `reconcileSession` re-evaluates claimability on
every event, so once attribution resolves it correctly finds the roster candidate and
calls `applyClaim` — but without an explicit cleanup step, the stale `visitorsBySessionId`
entry for that same `sessionId` was never removed, producing two `RuntimeCharacter`s for
one session in `getRuntimeCharacters()`.

**Why this matters**: `applyClaim` now starts with
`this.visitorsBySessionId.delete(session.sessionId)` before setting the claim. If
`applyClaim`/`applyVisitor`/`reconcileSession` in `scene.ts` are ever refactored, preserve
this cleanup — it's easy to drop silently since nothing else references it, and no
existing AC (AC-4/AC-5) happens to exercise the "attribution resolves late" ordering
(the regression test that caught it is `Scene: visitor + leave (AC-5) > does not leave a
duplicate ghost visitor when late-arriving attribution turns a visitor into a claim` in
`scene.test.ts`, added specifically for this).

**Known deferred gap**: subagent sessions (`Task`-spawned, `subagentType` on the raw
`OfficeEvent`) were supposed to route to a meeting room per the M1-4a design memo item 3,
but `office-state.ts`'s `SessionCharacter` (frozen this cycle — out of game-engine-dev's
scope) never surfaces `subagentType` in its snapshot. Without that signal, `scene.ts`
cannot distinguish a subagent session from any other unattributed/duplicate-role session,
so subagents fall through to the generic visitor path instead of a dedicated meeting-room
destination. This is documented inline in `scene.ts`'s file header comment. **How to
apply**: if a future cycle adds `subagentType` passthrough to `office-state.ts`'s
`SessionCharacter`/`upsert`, `scene.ts`'s `applyVisitor`/`resolveVisitorDestination` is
the place to add real meeting-room routing (look for a room whose id/triggers indicate a
meeting room, distinct from `RECEPTION_DEPT_ID`).
