---
name: feedback-canvas-imperative-sizing
description: Mutate canvas.width/height imperatively via ref, not React state, when the game/ layer needs a computed canvas resolution
metadata:
  type: feedback
---

When the `<canvas>` element's pixel resolution needs to be derived from data that only resolves after an async fetch (e.g. `OfficeLayout.floors[0].grid` from `/api/layout`), set `canvasRef.current.width`/`.height` imperatively inside the `useEffect`, not through `useState`.

**Why**: the project's absolute constraint (per `.claude/agents/ui-dev` persona and `.claude/rules/game-layer.md`) is that game/render-affecting values must not live in React state. Canvas resolution is exactly this kind of value — it's consumed every frame by `renderer.ts`'s `draw()` (`canvas.width`/`canvas.height` read directly), not displayed as text anywhere in the React tree, so it doesn't qualify for the "low-frequency UI display value" carve-out that `connected`/`sessionCount` get.

**How to apply**: keep a static literal placeholder size in JSX (e.g. `width={960} height={480}`) as the pre-fetch default, then after the layout resolves, do `canvas.width = grid.cols * grid.tileSize; canvas.height = grid.rows * grid.tileSize;` directly on the DOM node via the ref. This is safe against React's reconciliation: React only re-applies a DOM attribute when the *prop value from the current render* differs from the *prop value at the previous render* — since the JSX literal never changes across re-renders, React never overwrites the imperative mutation, even when the component re-renders for unrelated reasons (e.g. `sessionCount` updates via `state.subscribe`). Verified working end-to-end against a real `cc-sier-adapter` import (3 floors, tileSize-derived grid) in M1-4a. See [[project-page-tsx-game-layer-wiring]].
