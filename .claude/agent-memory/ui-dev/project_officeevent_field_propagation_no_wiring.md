---
name: project-officeevent-field-propagation-no-wiring
description: Adding an optional field to OfficeEvent (protocol) needs zero extra wiring in OfficeView.tsx — it already reaches both narration.ts and session-list.ts through existing plumbing
metadata:
  type: project
---

Confirmed while implementing ADR-007 (b)-1 (`requestText` display, 2026-08-16): when a new optional field is added to `OfficeEvent` in `packages/protocol`, it reaches the two existing UI display paths **without touching `OfficeView.tsx`**:

1. **Narration path**: `OfficeView.tsx` already does `eventLogBuffer.push(parsed)` with the full parsed `OfficeEvent` (not a projection), and `buildNarrationText(eventLog[0] ?? null)` (`apps/web/app/lib/narration.ts`) receives that same full event object. A new field is simply present on `event.<field>` inside `buildNarrationText` with no plumbing change.
2. **Session-list path**: goes through `OfficeState.applyEvent` (`apps/web/game/office-state.ts`) → `SessionCharacter.<field>` → `session-list.ts`'s `toRow()`. This one *does* require a real code change (the field must be explicitly populated onto `SessionCharacter` in `applyEvent`/`upsert`, following the existing `attributionPatch`-style "only add the key when the incoming event actually carries a value" pattern so upsert's default-to-existing spread isn't clobbered) — but still nothing in `OfficeView.tsx` itself.

**How to apply**: when a future field is added to `OfficeEvent` (e.g. the ADR-007 (b)-2 follow-up: Canvas overhead speech bubble / hover card showing `requestText`, tracked in `[[project-adr007-b1-request-text-display]]`), check narration/session-list wiring first — it's very likely already free. Only `OfficeState` (game/, React-free) and the two `app/lib/*.ts` display functions need new code; `renderer.ts`/`RuntimeCharacter` (game-engine-dev territory) is the one place that actually needs new plumbing for a Canvas-drawn feature, since renderer reads from `Scene`/`RuntimeCharacter`, not straight from `OfficeEvent`.

Also established a shared `truncateText(text, length = 40)` helper in `apps/web/app/lib/format.ts` (default 40 chars + "…", same file as the pre-existing `shortenSessionId`) — reused by both `session-list.ts` and `narration.ts` for consistent short-form display of free-text fields. Reuse this instead of re-deriving truncation logic per call site.
