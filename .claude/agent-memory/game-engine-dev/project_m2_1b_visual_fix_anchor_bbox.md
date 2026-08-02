---
name: project-m2-1b-visual-fix-anchor-bbox
description: M2-1b character-sprite visual fixes (too small / loose crop / wrong placement) — CELL_BBOX tight-crop table, foot-anchor draw formula, and the sheet.draw() size-param gotcha
metadata:
  type: project
---

M2-1b (2026-08-02, branch `feat/2026-08-02-m2-char-visual`) fixed three visual bugs the
user reported after eyeballing `:3001` for [[project_m1_4b_subagent_spawn_and_tile_allocation]]'s
successor M2-1 (PNG sprite sheet adoption): ①characters too small ②loose/dirty crop (white
halo) ③wrong placement (feet not on tile). Orchestrator had already re-cut
`apps/web/public/assets/characters/office.png` to a transparent RGBA PNG (flood-filled the
white background, protected internal white shirt pixels) and alpha-measured a tight bbox
per sprite-sheet cell before handing off the `renderer.ts` fix.

**Fix shape** (`apps/web/game/renderer.ts`):
- `cellFor(role, dept)` now returns a tight measured bbox (`CELL_BBOX[index]`, exported for
  direct testing) instead of the full 384x512 macro-cell. `sw`/`sh` per index are all
  `< 384`/`< 512` — this is the "①②" regression-check invariant (see cellFor tests).
- Draw call switched from a fixed `SPRITE_SIZE_PX=24` top-left blit to a **named-constant
  height + foot(bottom-center)-anchor** formula, computed once per character per frame:
  ```
  drawH = tileSize * SPRITE_HEIGHT_TILES   // SPRITE_HEIGHT_TILES = 2.4, tune-here constant
  drawW = drawH * (sheet.frameWidth / sheet.frameHeight)
  footX = screenX + tileSize / 2
  footY = screenY + tileSize
  dx = footX - drawW / 2
  dy = footY - drawH
  sheet.draw(ctx, direction, pose, dx, dy, drawW)
  ```
  This works unmodified for both the PNG sheet (`frameWidth/frameHeight` = the tight bbox's
  own aspect) and the generated fallback sheet (`frameWidth/frameHeight` = `FRAME_WIDTH(20)/
  FRAME_HEIGHT(28)`) because `SpriteSheet.draw()`'s `size` param always recomputes the dest
  height internally as `size * (sheet.frameHeight/sheet.frameWidth)` — passing `drawW`
  (already derived from that same ratio) makes the internal recompute land back on `drawH`
  exactly. **Gotcha for future tuning**: if you ever change how `drawW` is derived without
  keeping it proportional to `sheet.frameWidth/frameHeight`, `sheet.draw()`'s internal height
  math will silently stretch the sprite — don't pass an arbitrary width to `draw()`.
- All z4 overlays (`drawOverlay` bubble+name, `drawSubLabel`, `drawFocusRing`) were
  re-anchored off `footX`/`dy`(sprite top)/`footY` instead of the old tile-top-left `(x,y)`,
  via named gap constants (`BUBBLE_GAP_PX`, `NAME_GAP_PX`, `OVERLAY_CHAR_WIDTH_PX` for
  text-centering-by-approximation since canvas `textAlign` stays `"left"` throughout this
  file by convention).

**Reachability gotcha in `DEPT_CELL_INDEX`**: the sheet has 8 macro-cells (index 0-7) but
only 7 are reachable through `DEPT_CELL_INDEX` (index 5 is shared by `dept-research`/
`dept-retail-domain`; index 7 has no dept mapped to it at all — a reserved/future slot).
`cellFor`-based tests can only exercise 7 of the 8 `CELL_BBOX` entries; the 8th needed a
direct test against the exported `CELL_BBOX` table. If a future dept is added and mapped to
index 7, `CELL_BBOX[7]` already has a correct measured bbox waiting.

**All tuning knobs are named constants at the top of `renderer.ts`** (per explicit
orchestrator instruction, since the visual result itself was unverified by either of us —
only `:3001` eyeballing by the user can confirm final values): `SPRITE_HEIGHT_TILES`,
`BUBBLE_HEIGHT_PX`, `BUBBLE_GAP_PX`, `NAME_GAP_PX`, `OVERLAY_CHAR_WIDTH_PX`.

See also [[feedback_task_spec_and_report_format]] for how this task was specced (orchestrator
had already done pixel-diagnosis/measurement; my job was pure `renderer.ts` implementation +
test updates, not re-deriving the bbox numbers myself).
