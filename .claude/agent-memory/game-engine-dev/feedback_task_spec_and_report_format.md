---
name: feedback-task-spec-and-report-format
description: orchestrator tasks for this repo arrive as exhaustive specs (exact signatures/field names/colors) and expect an explicit red-then-green TDD report with test counts and typecheck result
metadata:
  type: feedback
---

Tasks handed to `game-engine-dev` in this repo (delegated from an orchestrating agent,
often referencing a design memo under the scratchpad) tend to specify implementation
details exhaustively: exact function signatures (e.g. `toolToState(toolName: string |
undefined): CharacterState`), exact field names for classes (`Map<sessionId, {...}>`),
exact hex color codes per state, and an exact TDD procedure to follow (write tests for
file A and B, run to confirm red, implement, run to confirm green, run typecheck).

**Why:** These specs are themselves the product of a prior design-review pass (memo
explicitly calls out review-driven corrections, e.g. "Glob/Grep → read" being added
after an architecture-doc cross-check). Deviating from the literal spec risks
reintroducing issues that were already caught upstream.

**How to apply:** Implement literally to the given signatures/field names/values rather
than substituting "cleaner" alternatives, unless something in the spec conflicts with
the game-layer React-isolation constraint (in which case that constraint wins — see
[[project-game-layer-react-isolation]] if written). When reporting back, always include:
list of files created (absolute paths), the red-phase failure evidence (command output
showing 0 passing / N failing or a collection error), the green-phase success evidence
(command output showing N passing), and the `typecheck` command result — this is the
expected acceptance-evidence format for this repo's subagents, not just for this task.
