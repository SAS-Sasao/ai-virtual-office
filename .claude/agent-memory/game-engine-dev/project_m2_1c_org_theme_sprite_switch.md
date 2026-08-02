---
name: project-m2-1c-org-theme-sprite-switch
description: M2-1c per-org sprite theme switch (office/rpg) — ORG_THEME lookup, lazy per-theme PNG loading, CELL_BBOX split into two theme tables, and a function-type-assignability gotcha hit while widening SpriteImageLoader from 0-arg to 1-arg
metadata:
  type: project
---

M2-1c (2026-08-02, branch `feat/2026-08-02-m2-char-visual`, on top of
[[project_m2_1b_visual_fix_anchor_bbox]]'s `5d224d9`) added **org-based sprite theme
switching** to `apps/web/game/renderer.ts`: `jutaku-dev-team` → `rpg` (fantasy sprite
sheet), everything else (including unknown/future orgs) → `office` (default, safe
fallback). Orchestrator had already re-cut a second transparent RGBA sprite sheet
(`apps/web/public/assets/characters/rpg.png`, 1536×1024, same 4×2 macro-cell layout as
office.png) and measured its tight per-cell bbox before handing off implementation.

**Shape of the change** (`apps/web/game/renderer.ts`):
- `themeForOrg(org): "office" | "rpg"` — a flat `ORG_THEME` lookup table with `office` as
  the fallback for anything not explicitly listed. Deliberately *not* derived from any
  characteristic of the org (no heuristics) — it's a decision table the orchestrator owns
  and hands me updates to, one line per org.
- `CELL_BBOX` was split into `OFFICE_CELL_BBOX` / `RPG_CELL_BBOX` (both exported, both
  still directly testable per-index like the M2-1b table was) plus a
  `CELL_BBOX_BY_THEME: Record<SpriteTheme, readonly SpriteCell[]>` lookup.
  `DEPT_CELL_INDEX`/`DEFAULT_CELL_INDEX` stayed a **single shared table** — both themes
  use the same dept→index assignment, only the pixel rectangles differ per theme. `cellFor`
  gained a leading `theme` param: `cellFor(theme, role, dept)`.
- `SpriteImageLoader` widened from `() => Promise<SpriteSourceImage>` to
  `(src: string) => Promise<SpriteSourceImage>`. Renderer now does **lazy, per-theme,
  on-demand loading**: a `Map<SpriteTheme, SpriteSourceImage>` + `Set<SpriteTheme>` (started
  set) live inside `startRenderer`'s closure; `ensureThemeImageLoading(theme)` is called
  from inside `getOrBuildSpriteSheet` (i.e. only when a character of that theme is actually
  about to be drawn) and is a no-op if that theme's load already started. This means an
  org-only-office deployment never fetches `rpg.png` at all — themes are loaded strictly on
  demand, not eagerly both at renderer start. Each theme's `.then()` clears the *entire*
  `spriteCache` (not just that theme's entries) on load — same one-time-global-clear
  simplification the M2-1b single-theme version already used; harmless since sheet rebuild
  is cheap and cache repopulates on the next draw.
- `OfficeView.tsx`'s `loadOfficeSpriteImage()` (fixed URL) became `loadSpriteImage(src)`
  (generic, receives `SPRITE_SHEET_SRC[theme]` from renderer) — this is the *only* place
  `new Image()` may appear (game/ React/DOM isolation, see `.claude/rules/game-layer.md`).

**Gotcha hit during the `SpriteImageLoader` signature widening**: I initially assumed the
`(...a: never[]) => Promise<SpriteSourceImage>` trick used in a renderer.test.ts helper's
param type (`startWithLoader`) would keep type-checking after the widening, on the theory
that a `never[]` rest param makes a function type assignable *to* anything. That's true in
some contexts but **not** when the *target* type has a concrete parameter (`(src: string) =>
...`): TS still requires the source's parameter type to accept `string`, and `never` doesn't
accept `string`, so it now errors with "Types of parameters 'a' and 'src' are incompatible."
Fix was mechanical — change the test helper's param type to the same real shape as the
new `SpriteImageLoader` (`(src: string) => Promise<SpriteSourceImage>` or just import the
exported type). Lesson: don't reach for the `never[]` widening trick to dodge a signature
change in test helpers; just match the real (possibly-updated) function type.

**Test-writing gotcha (mine, not a design issue)**: in the new multi-theme
`startRenderer` test, I forgot to reset the shared `drawImageCalls` recording array between
"draw while unresolved (generated fallback)" and "draw after resolve (PNG)" pumps twice in a
row — the assertion `sprites.every(args => args[0] === EXPECTED_IMAGE)` failed because it
was checking the concatenation of both frames' draw calls, not just the latest frame's. Any
test asserting "this frame's sprite source" against an array-accumulating draw stub must
clear the array (`drawImageCalls.length = 0`) immediately before the `raf.pump()` whose
frame it wants to inspect, not just at test setup.

See also [[feedback_tdd_hook_noise]] (this task's red-phase typecheck-touched errors were
all expected/mechanical) and [[feedback_node_test_env_no_dom_di]] (still holds: `new
Image()` stayed confined to `OfficeView.tsx`, never entered `game/`).
