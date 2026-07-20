---
name: m1-2a-web-db-persistence
description: apps/web/db(SQLite+drizzle)永続化とingest/stream結線をTDDで追加した際の判断・ハマりどころ(coordinatorから領域拡張指示を受けた回)
metadata:
  type: project
---

M1-2a の最終タスクとして、通常の担当外である `apps/web/db/` の SQLite 永続化を coordinator から明示的に指示されて実装した（[[m1-2a-relay-persistence]] の続き）。正本ペルソナは `packages/relay` 中心だが、ingest/stream route handler は元々担当領域内であり、coordinator の明示指示は agent メッセージとして正当な作業指示なので実施した（許可設定変更ではなく通常の実装作業のため）。53 テスト green（既存39 + client 5 + events 9）、typecheck/build とも exit 0。

**apps/web は `moduleResolution: "bundler"` であり、relative import に `.js` 拡張子を付けてはいけない**。`packages/relay`/`packages/protocol` は Node ESM（`moduleResolution: "NodeNext"` 相当）で `.js` 拡張子必須だったため、最初 `db/*.ts` を relay と同じ流儀（`from "./schema.js"`）で書いてしまった。**`tsc --noEmit` と `vitest` はどちらもこれを検出できず素通りした**（vite/esbuild のバンドラ解決は拡張子無し・有りの両方を許容するため）。**`next build`（webpack）だけがこれを実際に解決できず `Module not found` で落ちる**。これは m1-1-web-adapt の "TDD の red は vitest（型チェックなし）で取れる" の弱点そのものを踏んだ形で、**apps/web で新規モジュールを追加したら typecheck・vitest が通った後も必ず一度 `next build` まで通すこと**（今回のように docker/tsc/vitest を全部通過してから最後の `next build` で初めて壊れているのが判明するパターンがある）。既存の `apps/web/**/*.ts` の import は全部拡張子無しという規約を先に `grep -rn "^import" apps/web` で確認しておけば防げた。

**better-sqlite3 のバージョンピン根拠は実測でも再確認できた**: `12.9.0` で ABI115（Node20 相当）・ABI137（本環境の Node24.16.0）とも curl 200 を確認（AC-9）。`pnpm --filter web add better-sqlite3@12.9.0` は問題なくプリビルドバイナリを取得してインストール完了した（gcc/make/python3/g++ が入っている環境だったが、フォールバックの node-gyp フルビルドは不要だった＝プリビルド一致の証拠）。

**`NEXT_DIST_DIR=<dir> next build` は毎回 `apps/web/tsconfig.json` と `apps/web/next-env.d.ts` を自動で書き換える**（[[m1-1-web-adapt]] で既知の挙動を再確認）。今回も `include` に `.next-verify/types/**/*.ts` が追記され JSON が展開形に整形された。**検証ビルド後は必ず `git diff apps/web/tsconfig.json apps/web/next-env.d.ts` を確認し、`git checkout --` で元に戻し `rm -rf apps/web/.next-verify` すること**。放置すると無関係な差分が最終コミットに混入する。

**DB 初期化時の 30 日 prune（要件§7）は `getDb()` シングルトンの初回生成タイミングに埋め込むのが最も自然**: `pruneOlderThan` を `db/client.ts` から `db/events.ts` に対して実行時 import しても、`events.ts` 側の `client.ts` 参照は `import type { Db }`（type-only、コンパイルで消える）なので実行時の循環 import にはならない。ただしこの「prune-on-init」自体のテストは書いていない（`:memory:` は接続ごとに独立しており、事前にファイルへ書き込んでから getDb() で再オープンして検証するには生の better-sqlite3 ハンドルの明示 close が必要で、`createDb()` がそれを外部に公開していないため、SQLITE_BUSY 等のflaky要因を避けて見送った）。`pruneOlderThan` 自体のロジックは `events.test.ts` で厳密に検証済みなので実質的なリスクは低いと判断したが、次にこの経路を触る担当は `resetDbSingletonForTests()` を使い、ファイルベース DB で 2 接続(seed 用に生 `Database` を直接 open/close → getDb() で再オープン) するテストを追加すると良い。

**`insertEvent(db, ev)` はシグネチャを 2 引数のまま保った**: coordinator の設計メモがそう明記していたため、`receivedAt` は関数内部で `Date.now()` を直接呼ぶ設計にした（`ts`/`seq` のように検索条件やテスト assertion の対象にならない「記録するだけ」の値なので、時刻注入の decisiveness ルールを厳密適用する必要性が薄いと判断）。テストでは `typeof rows[0].receivedAt === "number"` としか assert していない。

**NFR-4 退行検知テストの型**: `events.test.ts` の「機微情報が保存されない」テストは `Object.keys(row).sort()` を許可された列名リストと厳密一致させ、かつ `prompt`/`toolInput`/`cwd`/`transcriptPath`/`command`/`url` が含まれないことを明示 assert する二段構え。[[hooks-normalize-test-cases]] の relay 側パターンと対になる、DB 層での同種の防御。

関連: [[m1-2a-relay-persistence]] [[m1-1-web-adapt]] [[m1-1-protocol-extraction]]
