---
name: m1-1-relay-creation
description: packages/relay 新規作成（M1-1 第2タスク）時の設計判断・NFR-2実機検証結果・ハマりどころ
metadata:
  type: project
---

M1-1（`feat/2026-07-20-m1-1-protocol-relay` ブランチ）で `packages/relay` を TDD 新規作成した際の判断ログ。[[m1-1-protocol-extraction]] の続き。

**NFR-2 の実機検証（重要）**: `node packages/relay/dist/cli.js --port 0` を web サーバ未起動の状態で起動し、`/hooks/pre-tool` に実 POST したところ、`forward`（`http://localhost:3001/api/ingest` への fetch）が `ECONNREFUSED` で失敗したが、relay プロセスはクラッシュせず `console.warn` のみで `{ok:true, ignored:false}` の 200 を返し続けた。unhandled rejection も発生しなかった。**Relay の宛先（web）が落ちていても hooks 経路は正常に 200 を返す**ことを実機で確認済み。今後 forward.ts / server.ts を変更するときは、この「web 未起動でも relay 自体は健全」という前提を崩さないこと（catch を外したり await を忘れたりすると unhandled rejection でプロセスが落ちる可能性がある）。

**`--port 0`（ephemeral）+ 実ポート取得のパターン**: `createServer` に `getPort: () => number` を DI し、初期値は `desiredPort`（= 0 かもしれない）を返す関数として渡しておく。実際の bind は `@hono/node-server` の `serve(options, callback)` の `callback(info)` でしか分からないため、`callback` 内で外側スコープの `actualPort` 変数を更新し、`getPort` のクロージャがそれを参照する形にした。`/health` はリクエストの都度 `getPort()` を呼ぶので、起動直後の 1 回目のリクエストでも正しいポートが返る。**verify.sh 側はこの stdout 1 行 `relay listening on port <N>` をパースする契約**（設計メモ N2 対応）なので、文言や出力先（stdout / stderr）を変える場合は verify.sh 側も同時に直すこと。

**dist/cli.js に実行ビット(+x)が付かない**: `tsc` は shebang（`#!/usr/bin/env node`）をそのまま emit するが、ファイルパーミッションは `-rw-r--r--` のまま（+x なし）。今回のタスクは `node packages/relay/dist/cli.js` で直接起動する検証のみなので問題なかったが、`npx ai-office-relay` や pnpm の bin symlink 経由の実行（M1-2 スコープ）を検証する際は chmod +x が必要になる可能性がある。その時点で `pnpm --filter @ai-office/relay build` 後に `chmod +x dist/cli.js` する postbuild step の要否を確認すること。

**`/test/inject` の all-or-nothing 検証**: 配列の要素を 1 件ずつ `OfficeEventSchema.safeParse` し、最初の不正要素が見つかった時点で即 400 を返して forward ループに入らない（部分適用防止）。全件 valid の場合のみ forward ループへ進む。テストは「不正要素混じりの配列 → forwarded 配列が空であること」まで確認している（`accepted:0` の数値だけでなく実際に forward が 1 度も呼ばれていないことを assert するのが肝）。

**Hono のテスト手法**: 実サーバ・実ポートを一切使わず `app.request(new Request(url, init))` で完結させた（Hono インスタンスは fetch ハンドラそのものなので `Request` オブジェクトをそのまま渡せる）。ephemeral port を使うテストは今回書いていない（sleep やポート待ちが一切不要で決定論的）。実ポート起動確認は TDD テストではなく「実起動確認」の手動ステップとしてのみ実施し、テストスイートには含めていない。

**normalize.ts の移設**: `apps/web/lib/normalize.ts` の内容をロジック・コメント一切変えず `packages/relay/src/normalize.ts` へコピーし、import 元だけ `../game/protocol` → `@ai-office/protocol` に変更。`normalize.test.ts` も 20 ケースを assertion 不変のまま移設（import パスのみ `./normalize.js` に変更）。**apps/web 側の元ファイルはまだ削除していない**（次タスクで実施予定、削除すると `apps/web/app/api/ingest/route.ts` の import が壊れるため web 側の追従と同時に行う必要がある）。

次タスク（同サイクル内）: `apps/web/game/protocol.ts` 削除 + `@ai-office/protocol` import へ置換、`apps/web/lib/normalize.ts`/`normalize.test.ts` 削除、`apps/web/app/api/ingest/route.ts` を正規化済み OfficeEvent のみ受理する形に変更、gate-protocol-consumers 等のオーケストレータ配線。関連: [[normalize-whitelist-pattern]] [[hooks-normalize-test-cases]] [[m1-1-protocol-extraction]]
