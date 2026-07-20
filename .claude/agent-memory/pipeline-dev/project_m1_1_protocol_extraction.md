---
name: m1-1-protocol-extraction
description: packages/protocol 新規作成（M1-1 第1タスク）時の設計判断とハマりどころ
metadata:
  type: project
---

M1-1（`feat/2026-07-20-m1-1-protocol-relay` ブランチ）で `packages/protocol` を TDD 新規作成した際の判断ログ。設計正本は設計メモ rev.3（Phase 1 レビュー 2 回 fail 後、人間承認済み）。

**Why dist 公開（`build: tsc`）にしたか（N1 finding）**: 当初 src 直接公開も検討されたが、`packages/relay` の bin（`ai-office-relay`）は Node が直接 `dist/cli.js` を実行する。TypeScript の型ストリップは Node 20〜22.5 では使えず（本開発機は Node 24 のため欠陥が顕在化しない）、NFR-5「Node 20+ で動く」を満たすため protocol・relay 双方に `build: tsc` を必須にした。他パッケージが protocol を import するときは必ず `pnpm --filter @ai-office/protocol build` を先に実行しておく必要がある（dist は gitignore 対象で未コミット）。

**CharacterStateSchema を追加した理由**: 旧 `apps/web/game/protocol.ts` は `CharacterState` を素の union 型として手書きしていた（スキーマと型の二重管理）。`z.enum([...])` を正とし `z.infer` で型を導出する形に統一。8 状態（idle/type/read/terminal/browsing/thinking/waiting/done）は维持、順序・値は変更なし。

**seq フィールドの順序規約**: `seq: z.number().int().nonnegative().optional()` を追加。doc comment に「消費側は seq があれば seq 昇順、無ければ ts 昇順」「seq は Relay プロセス内単調増加のみ保証、Relay 再起動をまたぐ単調性は非保証（永続採番は M1-2）」を明記。この規約は relay/web 双方の実装がそのまま守るべき契約なので、seq を消費するコードを書くときは必ずこの doc comment を確認する。

**未知キー strip のテスト観点**: `Object.keys(parsed).sort()` で完全一致検証（部分一致だと新しいホワイトリスト外フィールドの漏れを見逃す）。加えて `JSON.stringify(result)` に機微文字列断片が含まれないことも assert（[[normalize-whitelist-pattern]] と同じ考え方をスキーマ層でも適用）。Zod の `z.object()` はデフォルトで unknown keys を strip する（`.strict()` 不要）ので、これは NFR-4 の「二重防御」の 1 層目として機能する。

**TDD 実測**: red 確認は `Cannot find module './events.js'`（events.ts 未実装）。green は 13 tests pass。build → dist 6 ファイル生成（events.js/d.ts/d.ts.map, index.js/d.ts/d.ts.map）。typecheck 0 error。`grep -rn "from ['\"].*\.ts['\"]" packages/protocol/dist` は 0 件（AC-9 の静的確認クリア）。

**tsconfig の include/exclude 注意**: `exclude: ["dist", "node_modules", "**/*.test.ts"]` を tsconfig.json に設定しないと `tsc` の build 時に `.test.ts` が dist に紛れ込む（vitest.config.ts の include はテスト実行専用で、tsc の除外には別途効かない点に注意）。

次タスク（同サイクル内）: `packages/relay` 分離、`apps/web/game/protocol.ts` 削除して `@ai-office/protocol` import へ置換、`apps/web/lib/normalize.ts` の relay への移設。関連: [[normalize-whitelist-pattern]] [[hooks-normalize-test-cases]]
