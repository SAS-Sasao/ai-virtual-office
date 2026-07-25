---
name: feedback-node-test-env-no-dom-di
description: apps/web's vitest environment is "node" (no jsdom) — any code touching Canvas/rAF/document in game/ must take those as required or lazily-referenced injected parameters, never as an eagerly-evaluated default
metadata:
  type: feedback
---

`apps/web/vitest.config.ts` sets `environment: "node"` project-wide (not jsdom) — this is
intentional (NFR-2: tests must never touch real DB/DOM side effects), not an oversight.
Any `game/` module that needs a `Canvas`/`CanvasRenderingContext2D`/
`requestAnimationFrame`/`document` must accept those as parameters (or a factory
function), because referencing the bare global at *module load or default-parameter
evaluation time* throws `ReferenceError` under vitest even if the function is never
called in a given test.

**How to apply** (established in M1-4a for `sprites.ts` / `renderer.ts`):
- Offscreen canvas creation (`sprites.ts`'s `createGeneratedSpriteSheet`,
  `renderer.ts`'s per-floor static layer) takes a required `CanvasFactory` parameter
  (`(width, height) => DrawableCanvas`) — no default that calls `document.createElement`.
  `DrawableCanvas` is a minimal structural interface (`width`/`height`/`getContext`), not
  `HTMLCanvasElement`/`OffscreenCanvas` directly, so a plain node test object satisfies it
  without a DOM present.
- `requestAnimationFrame`/`cancelAnimationFrame` in `renderer.ts`'s `RendererDeps` are
  *optional* params whose default is a thin arrow function wrapping the global identifier
  (`(cb) => requestAnimationFrame(cb)`) — safe because the global reference inside an
  arrow function body isn't evaluated until the arrow function is actually *called*, and
  tests always supply their own manual-pump stub instead of triggering that path.
- Main `<canvas>` (the one real callers pass in, e.g. `page.tsx`) can stay typed as
  `HTMLCanvasElement` (an ambient DOM *type*, zero runtime cost) — tests just build a
  structurally-compatible plain object and `as unknown as HTMLCanvasElement` cast it.
- Do **not** add a default canvasFactory that calls `document.createElement("canvas")`
  directly in a game/ module, even behind a `typeof document !== "undefined"` guard —
  keep that wiring in `apps/web/app/` (React side), matching the game-layer React/DOM
  isolation rule (`.claude/rules/game-layer.md`).
