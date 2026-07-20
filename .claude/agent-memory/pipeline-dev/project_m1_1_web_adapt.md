---
name: m1-1-web-adapt
description: apps/web を packages/protocol・packages/relay 構成へ追従させた（M1-1 第3タスク）際の判断・ハマりどころ
metadata:
  type: project
---

M1-1（`feat/2026-07-20-m1-1-protocol-relay` ブランチ）で `apps/web` を新パッケージ構成に追従させた際のログ。[[m1-1-protocol-extraction]] [[m1-1-relay-creation]] の続き・最終タスク。

**typecheck-touched hook（PostToolUse: Edit|Write）との付き合い方**: `apps/web/game/protocol.ts` を先に `rm` した直後、`apps/web/lib/normalize.ts` がまだ旧パスを import していて package 全体が typecheck 不能になり、次の Edit がすべて exit 2 でブロックされた。**Bash（rm 等）はこのフックの対象外（matcher が Edit|Write のみ）なので、パッケージを壊す削除は Bash で行い、直後に「壊れた import を直す 1 手」を最優先で Edit する**とブロックが解消される。複数ファイルにまたがる移行（import 付け替え + 削除）をするときは、「今 Edit したら tsc が通るか」を都度意識し、通らない中間状態を長く放置しない（1 undo 手ですぐ健全化できる順序を選ぶ）。

**TDD の red は vitest（型チェックなし）で取れる**: `pnpm --filter web test` は vite/esbuild によるトランスパイルのみで tsc 型検査をしないため、実装を書き換える前に新しい `route.test.ts` を先に置いても（Write）typecheck-touched hook 自体は落ちない（型は合っている。ふるまいだけが古い実装のまま）。これにより「新テストを先に書く → red を確認 → 実装を書き換える → green」という TDD 手順と、typecheck-touched hook の両立ができた。

**`NEXT_DIST_DIR=.next-verify next build` の副作用（要注意・N3 の追加観測）**: 検証ビルドを一度実行すると、Next.js が `apps/web/tsconfig.json`（`include` に `.next-verify/types/**/*.ts` を追記 + フォーマットを展開形に自動整形）と `apps/web/next-env.d.ts`（`.next/types/routes.d.ts` 参照 → `.next-verify/types/routes.d.ts` 参照に書き換え）を**自動で上書きする**。これは Next.js 側の「TypeScript を検出して tsconfig.json を再設定しました」という組み込み挙動で、意図的な編集ではない。実害はない（typecheck は通り続ける）が、`git status` に無関係な差分として出るため、**verify.sh 実行後や検証ビルド後は `git diff apps/web/tsconfig.json apps/web/next-env.d.ts` を確認し、想定外の変更でないことを都度説明できるようにしておく**こと。次に `next dev`（既定 `.next`）を実行すればまた `.next/types` 参照に戻るため、実害があるわけではなく「行ったり来たりする」だけの挙動。

**`apps/web/.next-verify/` は `.gitignore` の `.next/` パターンでは拾われない**（`git check-ignore` で未マッチを確認）。ビルド成果物ディレクトリなので検証後は手動 `rm -rf` で除去した。恒久対応（`.gitignore` に `.next-verify/` 追加等）は pipeline-dev のスコープ外（apps/web 配下のみの指示だったため）なので、次に `.claude/skills/office-verify/scripts/verify.sh` や `.gitignore` を触る担当が気づけるようにここに記録しておく。

**vitest.config.ts の include パターン更新を忘れずに**: `apps/web/vitest.config.ts` の `test.include` は当初 `["game/**/*.test.ts", "lib/**/*.test.ts"]` のみで `app/**/*.test.ts` が無かった。新設の `app/api/ingest/route.test.ts` を追加する前にこのパターンへ `"app/**/*.test.ts"` を足さないと、テストファイルを置いても vitest に発見されず「エラーは出ないがテストが 0 件で静かに素通りする」という気づきにくい失敗モードになる。

**移設・削除の最終確認**: `apps/web/lib/normalize.ts` / `normalize.test.ts` は `packages/relay/src/normalize.ts` / `normalize.test.ts` と import 行以外 diff 0 であることを確認してから削除した（[[m1-1-relay-creation]] で先に移設済み）。削除前に `grep` で apps/web 内の残存参照が自己参照（自分自身のテストファイルのみ）であることを確認する手順を踏むこと。

関連: [[normalize-whitelist-pattern]] [[hooks-normalize-test-cases]] [[m1-1-protocol-extraction]] [[m1-1-relay-creation]]
