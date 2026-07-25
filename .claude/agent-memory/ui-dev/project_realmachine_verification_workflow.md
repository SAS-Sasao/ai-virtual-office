---
name: project-realmachine-verification-workflow
description: How to do a real-machine check of apps/web against actual cc-sier-adapter output without touching ~/.ai-office or leaving build artifacts in git status
metadata:
  type: project
---

For tasks that require verifying `apps/web` against real (not fixture) data end-to-end, this is the working recipe (used for M1-4a page.tsx wiring, 2026-07-25):

1. **Real org data source**: `/home/toyoki05/cc-sier-organization` (has `.companies/`) is the real repo the `cc-sier-adapter` is designed against — it produces 3 orgs (`domain-tech-collection` / `jutaku-dev-team` / `standardization-initiative`), 18 characters total. There's already a real-repo integration test (`packages/cc-sier-adapter/src/real-repo.integration.test.ts`) that `describe.skip`s if this path is absent, confirming it's expected to exist in this dev environment.
2. Build the workspace packages the adapter/web depend on first: `pnpm --filter @ai-office/protocol build && pnpm --filter @ai-office/cc-sier-adapter build` (both `dist/` are gitignored, no cleanup needed).
3. Run the adapter CLI into a **scratchpad temp dir** (never `~/.ai-office/`): `node packages/cc-sier-adapter/dist/cli.js import --repo /home/toyoki05/cc-sier-organization --out "$TMP_LAYOUTS"`.
4. Start `apps/web` on a non-default port with env overrides: `AI_OFFICE_LAYOUTS_DIR="$TMP_LAYOUTS" AI_OFFICE_DB_PATH=":memory:" pnpm exec next dev -p 3005` (background, log to a file, poll the log for `"Ready in"` rather than sleeping blindly; grep the log for `EADDRINUSE` afterward to confirm no port clash).
5. Verify via `curl`: `/` → 200 + `<canvas` in HTML; `/api/layout` → 200 + JSON with `layout.floors.length === 3` and `characters.length === 18`; `/api/stream` (with `-N`, redirected to a file, `timeout`-bounded) → `event: hello` line confirms SSE wiring.
6. **Always confirm `~/.ai-office/` untouched** — compare `stat` mtimes on `~/.ai-office/events.db` before/after (should predate the test server start) and confirm no `~/.ai-office/layouts/` directory was created (proves `AI_OFFICE_LAYOUTS_DIR` override actually took effect instead of silently falling back to the default).
7. Kill the dev server by PID afterward and confirm the port is free (`lsof -i :PORT` / `ss -ltnp`), then `rm -rf` the temp layouts dir.

**`next build` side effect to watch for**: running `NEXT_DIST_DIR=.next-verify pnpm build` causes Next.js to auto-rewrite `apps/web/tsconfig.json` (reformats `include`/`lib`/`paths` arrays, adds `.next-verify/types/**/*.ts` to `include`) even though the file content is semantically unchanged. Always `git diff` / `git checkout --` this file (and `next-env.d.ts` if touched) after a verification build, and `rm -rf` the `.next-verify` dir — otherwise an unrelated formatting diff leaks into the PR.
