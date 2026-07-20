---
name: feedback-tdd-hook-noise
description: typecheck-touched hook prints blocking-looking errors during TDD red phase; this is expected noise, not a real failure, as long as the write already succeeded
metadata:
  type: feedback
---

When following strict TDD in this repo (write test file referencing a not-yet-created
module, confirm red, then implement), the `PostToolUse:Write` hook
(`.claude/hooks/verify/typecheck-touched.sh`) fires after every `Write` to a `.ts`/`.tsx`
file and reports `tsc` errors like `TS2307: Cannot find module './mapping'` for every
implementation file that doesn't exist yet.

**Why:** It's a `PostToolUse` hook, so it runs *after* the write has already landed on
disk — the error message looks like a block but the file content is not reverted. This
is exactly the state you want during the red phase (test references code that doesn't
exist yet), so seeing this message is expected and does not mean the `Write` failed.

**How to apply:** Don't treat these hook messages as something to "fix" mid-TDD-cycle —
verify the file was actually written (it will be), keep writing the remaining
test/implementation files in the planned order, and only worry once `pnpm --filter web
typecheck` (run explicitly, not via the hook's noisy per-write output) still fails after
all planned files for the cycle exist. In this project's M0 game-layer work
(`apps/web/game/protocol.ts` / `mapping.ts` / `office-state.ts` / `renderer.ts` /
`debug.ts`), the hook errors disappeared on their own once the referenced module was
created — no separate remediation step was needed.
