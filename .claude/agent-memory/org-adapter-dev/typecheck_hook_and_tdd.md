---
name: typecheck-hook-and-tdd
description: PostToolUse typecheck-touched hook が非テスト .ts の Write/Edit ごとに tsc --noEmit を強制するため、厳密な red-first TDD の運用に制約が出る
metadata:
  type: feedback
---

このリポジトリの `.claude/hooks/verify/typecheck-touched.sh`（PostToolUse）は、`Write`/`Edit` した TypeScript ファイルが属する workspace パッケージ全体に対し `tsc --noEmit` を実行し、失敗すると Write/Edit 自体をブロックする。対象は tsconfig.json の `include`（`src` から `**/*.test.ts` を除外）に従うため、**`*.test.ts` は対象外**（vitest 実行時にしか検証されない）。

**含意**: `parse-masters.ts` / `import-org.ts` / `attribution-index.ts` のような他モジュールへの依存が少ないファイルは、テストを先に書いて `Cannot find module` の red を確認 → 実装で green、という厳密な TDD 順序をそのまま踏める（テストファイルはフックの対象外なので red state で保存できる）。

一方 `cli.ts` のように多くの型・import を一度に確定させる薄い I/O シェルは、**未完成な状態では tsc --noEmit を通せず Write 自体が拒否される**ため、「先にテストを書いて red を見せる」ことが構造的に難しい（テストが `./cli.js` を import しようとしても、cli.ts 自体がまだ存在しない/コンパイルが通らない状態を経由できない）。このケースでは、cli.ts を一気に完成させてから cli.test.ts を書き、テストで実際に検証する（＝厳密な red-first ではなく、実装直後にテストで裏取りする準TDD）という運用が現実的。**理由を PR/報告で明示すること**（tests.md ルール 2 の趣旨を踏まえた例外運用）。

もう 1 つの落とし穴: JSDoc ブロックコメント（`/** ... */`）内に `*/` を含む文字列（例: パス例 `.companies/*/`）を書くと、コメントがそこで閉じてしまい後続行が生コードとして構文エラーになる（`TS1443` 等の連鎖エラーが出るが、原因箇所は最初の `*/` の位置）。ワイルドカードパスを説明する際は `.companies/ 配下の...` のように書き換えて `*/` の並びを避ける。
