---
name: project-m1-4a-connectivity-interior-anchor
description: door-tile reachability alone can miss a "sealed interior" bug when a door lands on a room corner; both cc-sier-adapter's checkFloorConnectivity and game's AC-3b test now also check an interior anchor tile. Notes a one-time, coordinator-approved exception to touch packages/cc-sier-adapter.
metadata:
  type: project
---

Phase 3 review (M1-4a, 2026-07-25) found a low-severity gap: `checkFloorConnectivity`
(`packages/cc-sier-adapter/src/import-org.ts`) and the game-side AC-3b integration test
only asserted that a room's **door tile** was BFS-reachable from the entrance, not that
the room's **interior** was. If a door ever lands on a room *corner* (e.g. `(room.x,
room.y+room.h-1)`), all 4 orthogonal neighbors of that tile are either wall or outside
the room — the door tile itself gets marked visited (reachable from the corridor below),
but BFS can never step *into* the room from it. Door-reachable + interior-sealed passes
the old check silently.

**Fix pattern**: both `checkFloorConnectivity` and `apps/web/game/layout-runtime.ts`'s
`roomInteriorAnchor` (pre-existing) compute a clamped-to-center "interior anchor" tile
per room and require it to be reachable too, not just the door. The adapter's version
(`interiorAnchor` in `import-org.ts`) is an intentionally independent duplicate of the
same center-tile-with-fallback-to-door logic — **not** a shared import, since
`apps/web/game` and `packages/cc-sier-adapter` are deliberately non-dependent on each
other (mirrors the existing `isWalkableTile` duplication pattern from M1-4a rev.1).
Regression test: `import-org.test.ts`'s `checkFloorConnectivity > reports an active room
as unreachable when its door sits in a corner`.

**Scope note**: `packages/cc-sier-adapter/src/import-org.ts` is normally
`org-adapter-dev`'s domain, not `game-engine-dev`'s (`apps/web/game/` only). This fix was
a coordinator-approved one-time exception ("この修正に限り許可") limited strictly to the
connectivity-check function and its test — do not treat this as a standing precedent for
touching `packages/cc-sier-adapter` in future cycles without the same explicit grant.
