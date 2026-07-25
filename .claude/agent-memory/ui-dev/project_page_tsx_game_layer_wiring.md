---
name: project-page-tsx-game-layer-wiring
description: How apps/web/app/page.tsx bridges async /api/layout fetch into game/ (layout-runtime, Scene, renderer, debug) without putting game state in React state
metadata:
  type: project
---

`apps/web/app/page.tsx` mounts the game layer via a single `useEffect` that:
1. Creates `OfficeState` synchronously and starts SSE subscription / prune timer immediately (independent of layout fetch).
2. Runs an async `init()` that awaits `fetch("/api/layout")` (via a `fetchLayoutData()` helper that swallows network errors and falls back to `{layout: null, characters: []}` — the same "never throw" contract as the server route), then calls `buildRuntimeLayout(layout, characters)` → `new Scene(...)` → `attachDebug(...)` → `startRenderer(...)`.
3. Guards the async continuation with a `disposed` flag set in the effect cleanup, so an unmount that races the fetch doesn't start a renderer/scene after teardown.
4. Stores the `Scene` in a `useRef` (not React state) so cleanup can call `scene.dispose()`; `RendererHandle` from `startRenderer` is a local `let` closed over by the cleanup function (no ref needed since nothing else reads it).

**Canvas sizing pattern**: canvas resolution (`canvas.width`/`canvas.height`) is derived from `runtimeLayout.floors[0].floor.grid` (cols/rows × tileSize) and set **imperatively via the ref** after the layout resolves, not via React state. This works because the JSX still declares static literal `width={960} height={480}` as a placeholder — React only reasserts a DOM attribute when the *prop value it computed* changes between renders, so as long as the JSX literal itself never changes, React never clobbers the imperative override on subsequent re-renders (e.g. from `sessionCount`/`connected` state updates elsewhere in the same component). See [[feedback-canvas-imperative-sizing]].

`?e2e=1` fast-mode flag is read via `new URLSearchParams(window.location.search).get("e2e") === "1"` **inside the effect** (not `useSearchParams()` from `next/navigation`), specifically to avoid Next.js's requirement that components calling `useSearchParams()` be wrapped in a `<Suspense>` boundary for static rendering — this sidesteps a build-time gotcha since page.tsx is already effectively client-only (mounts via `useEffect`, uses `EventSource`).

**Why this matters for future tasks**: M1-4b (floor tabs, waiting panel, session list) will extend this same effect/ref pattern — `RendererHandle.setFloor(org)` is already exposed by `renderer.ts` for that purpose but currently unused (floor is fixed to `runtimeLayout.floors[0]`).
