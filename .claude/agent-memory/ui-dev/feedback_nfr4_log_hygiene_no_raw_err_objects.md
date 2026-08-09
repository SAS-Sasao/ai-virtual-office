---
name: feedback-nfr4-log-hygiene-no-raw-err-objects
description: For ingest/parse-failure paths that touch externally-influenced input, never pass a raw Error object or its .message to console.warn — interpolate only err.name into a single string
metadata:
  type: feedback
---

**Rule**: when logging a drop/failure on a code path that parses external input (e.g. `JSON.parse` on a request body that could theoretically be a raw/malformed hooks payload bypassing Relay's normalization), do not do `console.warn("prefix", err)` or include `err.message` — build one plain string with only `err.name` interpolated and pass that single string as the sole `console.warn` argument: `` console.warn(`web: ingest dropped unparseable body (${err instanceof Error ? err.name : "unknown"})`) ``.

**Why**: NFR-4 (this project's sensitive-data policy — prompt bodies/file contents/URL queries must never reach logs or the cloud). V8's `JSON.parse` `SyntaxError.message` embeds a fragment of the malformed input (e.g. `Unexpected token o in JSON at position 1`), so passing the raw error object or `.message` risks leaking body content into (future Vercel-bound) server logs even though the code "only logged the error". This was an explicit Phase-1 design-review finding (`cycle2-observability-sse-design-memo.md` rev.2 finding 4) on a first design pass that had proposed `catch (err) { console.warn(prefix, err) }` — the fix was demoted from "pass err as 2nd arg" to "interpolate err.name only, single string arg, no err object at all".

**How to apply**: this is a general pattern for this codebase, not just the ingest route — any `catch` block that logs a failure to parse/validate *user- or network-supplied* data (as opposed to internal invariant violations) should default to name-only, single-string logging unless there's a specific reason the full error is safe (e.g. DB connection errors, which are about the local environment, not attacker/user-controlled content — see the existing `db/client.ts` `console.warn(...msg, err)` pattern for insertEvent/db-open failures, which *is* fine to pass the full err since it doesn't echo request body content).
