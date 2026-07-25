---
name: m1-4a-walk-leave-layout-api
description: M1-4a pipeline-dev分: CharacterState walk/leave追加+GET /api/layout新規実装のTDD記録。並行作業(door必須化)の待ち方・gate-protocol-consumersが暴いたgame/renderer.tsの網羅Recordブレイク・next buildが実は無害だった検証
metadata:
  type: project
---

`feat/2026-07-25-m1-4a-game-render` ブランチで pipeline-dev 担当分（`packages/protocol/src/events.ts` の `CharacterStateSchema` に `walk`/`leave` 追加 + `apps/web/app/api/layout/route.ts` 新規 + `apps/web/lib/layout.ts` 新規）を TDD で実装した記録。同時並行で org-adapter-dev が `packages/protocol/src/layout.ts` の `RoomSchema` に `door: {x,y}` を必須フィールドとして追加する破壊的変更を進めていた（設計メモ rev.2 F1 対応）。protocol 65 / relay 112 / web 88（69→+19）で green。

**並行エージェントによる protocol 破壊的変更の「着地待ち」は Bash の `run_in_background` によるポーリングループで実現できる**: `timeout 1200 bash -c 'while ! grep -q "door" packages/protocol/src/layout.ts; do sleep 20; done; echo DOOR_LANDED'` を `run_in_background: true` で起動し、他の独立タスク（events.ts の TDD、lib/layout.ts の実装）を進めながら完了通知を待った。実際には他タスクを2〜3個進めている間（数分）に着地し、20分のタイムアウトに達することはなかった。**Monitor ツールが無い環境（Read/Write/Edit/Bash のみ）でも `run_in_background` + grep ポーリングで同等のことができる**。

**door 必須化のような「他エージェント待ちの破壊的スキーマ変更」に依存するテストケースは、fixture に先取りで door を書いておけば自然に red→green のタイミングが依存関係の着地と一致する**: 「旧形式（door 無し）は null フォールバックになる」という assertion は、door が未着地の間は（door が任意扱いなので普通に valid と判定され）**red**、着地後は自動的に **green** になる。これは実装バグによる red ではなく依存未着地による red であり、正当な TDD の一形態として報告に明記してよい（今回は着地が早く、実際に red の瞬間を確認する前に green になった）。同様に「room.door がレスポンスまで保持される」assertion も同じ理由で着地待ちだった。

**【重要】protocol の enum（`CharacterStateSchema`）に値を追加すると、`apps/web/game/renderer.ts` の `Record<CharacterState, string>`（`STATE_COLORS`）が TypeScript の網羅チェックで壊れ、`typecheck-touched` hook が web パッケージ全体の typecheck 失敗としてブロックしてくる**: 今回 `walk`/`leave` を追加した際に発生。タスク指示では `apps/web/game/` を触らないことになっていたが（game-engine-dev の次工程のため）、**protocol 変更の直接の結果として起きた exhaustive Record の型エラーは、pipeline-dev の責務（CLAUDE.md 規約2「型変更時は relay/web 両方のテストを実行してから完了」）の範囲内として最小パッチ（2エントリ追加のみ、色は暫定値・コメントで「renderer 全面改修で置き換わる想定の compatibility patch」と明記）で解消してよいと判断した**。「触らない」指示は「game-engine-dev の設計作業（レイヤー・スプライト等）をやらない」という意味であり、「protocol 変更で必然的に生じる型エラーを放置してよい」という意味ではない、という解釈。次にこの手の enum 拡張をする担当は、`grep -rln "Record<CharacterState" apps packages` で網羅チェック箇所を事前に洗い出すこと。

**[[m1-2a-phase3-review-fixes]] の「next build が本番 DB を汚す」原因を訂正**: 詳細は当該メモリに追記済み。実際は `pnpm dev` + `pnpm relay` が既に常駐しており、自セッションの hooks トラフィックで実 DB が継続的に更新されていただけだった。`~/.ai-office/events.db` の変化を見たら先に `ps aux` で常駐プロセスを疑うこと。

**`GET /api/layout` の route レベルテストは `vi.spyOn(layoutLib, "resolveLayoutsDir")` で一時ディレクトリへ誘導し、ファイル IO 自体は本物（`mkdtempSync`/`writeFileSync`）を使う設計にした**: 詳細な parse/validate 分岐は `lib/layout.test.ts`（`loadOfficeLayoutData` の単体テスト、14ケース）に寄せ、`route.test.ts`（5ケース）は「実ディレクトリに対して 200 + 期待した形の JSON を返す」という結線確認のみに絞った。ingest route.test.ts の `vi.spyOn(dbClient, "getDb")` パターンと同じ思想（[[m1-3-relay-attribution]] 等で確立済みの ESM named import への spy が機能する前提）。

**ログの機微配慮**: `loadOfficeLayoutData` の警告ログはファイル内容・ディレクトリのフルパスを一切含まない固定文言（「再インポートしてください」の趣旨のみ）にした。events.ts の NFR-4 フィルタと同じ「漏らさない」思想をログにも適用（[[hooks-normalize-test-cases]] と同系統の配慮）。

関連: [[m1-3-relay-attribution]] [[m1-2a-web-db-persistence]] [[m1-2a-phase3-review-fixes]] [[m1-1-web-adapt]]
