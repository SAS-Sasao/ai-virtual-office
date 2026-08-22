---
name: project-adr007-b2-request-text-canvas
description: ADR-007 impl (b)-2 (2026-08-22) — requestText propagation scene->renderer, stacked-overlay layout trick that preserves exact backward-compat position, and a state-color test gotcha
metadata:
  type: project
---

Phase 2 TDD implementation of ADR-007 (b)-2 (2026-08-22, on top of (b)-1's `738b1f3`,
design memo at orchestrator scratchpad
`adr007-impl-b2-design-memo.md`): draws `SessionCharacter.requestText` (already wired to
`OfficeState` by (b)-1) as a head-overhead Canvas caption + a hover-card line. Scope was
strictly `apps/web/game/{scene.ts,scene.test.ts,renderer.ts,renderer.test.ts}` — no
protocol/relay/app/office-state changes needed since (b)-1 already exposed
`SessionCharacter.requestText`.

**Data propagation (`scene.ts`)** — `requestText?: string` added to `RuntimeCharacter` and
`HoveredCharacterDetail`, following the exact same pass-through pattern as `toolName`:
- `applyClaim`: `character.requestText = session.requestText` (session unit).
- `releaseClaim`: `character.requestText = undefined` (paired clear, same as `toolName`).
- `applyVisitor` has **two branches that both need it** — the new-spawn `RuntimeCharacter`
  literal *and* the existing-visitor update branch (`existing.requestText = ...`). This
  mirrors a finding from [[project_m1_4a_scene_claim_visitor_design]]/M1-4b's dual-branch
  bugs: any per-session field added to `applyVisitor` needs both branches touched or you get
  a silent "works on first-touch, drops on late update" gap.
- **subs (`reconcileSubagents`/`spawnSub`) deliberately never set `requestText`** — it's a
  session-unit concept, sub keys are `parentSessionId:seq` synthetic and have no independent
  requestText source. This is enforced by a regression test (AC-6), not just a doc comment.
- Only `pre_tool` and `user_prompt` events carry `requestText` in office-state.ts (not
  `session_start`). To test the "brand-new visitor spawn already carrying requestText"
  branch (AC-1b) you must send `pre_tool` as literally the *first* event for that
  `sessionId` — `session_start` first + later `pre_tool` only exercises the
  existing-update branch (AC-1c), not new-spawn.

**Rendering (`renderer.ts`)**:
- `truncateForDisplay(text, maxChars)`: exported pure fn, game-local (does **not** import
  `apps/web/app/lib/format.ts`'s `truncateText` — that's app-layer, would violate game/
  self-containment). Truncated output length is always exactly `maxChars` (cap at
  `maxChars-1` chars + `…`), so `result.length` is a cheap/precise assertion in tests.
- **Stacked overlay layout trick** to add the request caption "below the state bubble"
  (i.e. between the bubble and the sprite's head) without perturbing the *existing* bubble
  position when `requestText` is absent: introduced a `cursorBottom` accumulator starting at
  `stackBottom = topY - BUBBLE_GAP_PX`. The caption (if present) claims
  `[cursorBottom - REQUEST_CAPTION_HEIGHT_PX, cursorBottom]` and pushes `cursorBottom` up by
  `REQUEST_CAPTION_HEIGHT_PX + REQUEST_CAPTION_GAP_PX`; the bubble then always draws at
  `cursorBottom - BUBBLE_HEIGHT_PX`. When there's no requestText, `cursorBottom` never moves,
  so `boxY` is byte-for-byte the pre-existing formula — a real "prove-by-construction"
  no-regression instead of an if/else duplicate of the old math. Worth reaching for this
  pattern whenever a new optional overlay element needs to stack above/below an existing one
  without a conditional height branch.
- **New caption box must use a color/width that can never collide with the existing
  hover-card counting assertion** (`strokeStyle==='#9aa0b8' && w===168`, from M1-4b). Chose
  a dedicated `REQUEST_CAPTION_BORDER_COLOR = "#5a6088"` even though the width alone
  (`maxChars=18` → well under 168px) already made collision impossible — belt-and-braces
  since a future maxChars bump could otherwise silently break that old assertion.
- `drawHoverCard` always renders a `req: <...>` line, falling back to `req: -` when
  `requestText` is absent (rather than omitting the line) — keeps line count/card height
  fixed (`CARD_HEIGHT_PX` 96→109, +13px for the 7th line) instead of conditional height math.

**Test gotcha (mine)**: copied a sibling test's stale comment claiming "claim 直後は
post_tool 等が無いので idle 色 (#9aa0b8)" into a new hover-card test, but that new test's
event was `pre_tool(toolName: "Edit")`, which puts the character in `type` state
(`STATE_COLORS.type === "#7ef29a"`), not idle. Any new hover-card/overlay test that sends a
`pre_tool` event must derive the expected border/bubble color from the *actual* resulting
`CharacterState` → `STATE_COLORS` mapping, not copy-paste a color literal from a
differently-triggered sibling test.

**TDD process note**: implemented `scene.ts` before writing its tests in this session
(order slip). To recover genuine red evidence rather than fabricate it, used
`git stash push -- apps/web/game/scene.ts` (leaving the new test file in place), ran the
suite to confirm the new assertions failed for the right reason, then `git stash pop` to
restore the implementation. Useful recovery move when TDD ordering gets out of sequence
instead of skipping straight to trusting the implementation.

See also [[feedback_tdd_hook_noise]] (red-phase `typecheck-touched` PostToolUse errors for
the not-yet-exported `truncateForDisplay` were expected noise, not a real failure) and
[[project_m1_4b_subagent_spawn_and_tile_allocation]] (origin of the session-vs-sub scoping
convention this cycle continues).
