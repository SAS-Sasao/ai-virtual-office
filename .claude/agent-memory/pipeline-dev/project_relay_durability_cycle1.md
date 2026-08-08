---
name: relay-durability-cycle1
description: relay durability サイクル1（seq fsync原子性・cli.ts構造改修・normalize safeParse/toFileBase）のTDD実装で確定した設計判断・逸脱・パターン
metadata:
  type: project
---

`feat/2026-08-08-relay-durability` ブランチ、設計メモ rev.2（Phase 1 composite 0.91 pass）を Phase 2 TDD で実装。`packages/relay/src/{seq.ts, cli.ts, normalize.ts}` + 各 `.test.ts` のみ変更（protocol/web 不変）。112→162 テスト（既存 0 削除・純増 50）、typecheck/build（`--filter @ai-office/relay` 限定）とも exit 0。関連: [[m1-2a-relay-persistence]] [[m1-2b-relay-health-stats]] [[m1-2b-cli-setup-doctor-teardown]]。

**設計メモからの意図的な逸脱（要 Phase 3 レビュー確認）**: `validatePort` の許容範囲は監査由来の文言「1-65535」ではなく **0-65535**（0 = エフェメラルポート）にした。理由: `.claude/skills/office-verify/scripts/verify.sh` が `node dist/cli.js --port 0 ...` に実依存しており（`grep -oE 'listening on port [0-9]+'` でポート検出する契約）、1-65535 に狭めると verify.sh が即死する。design memo 自体が cli.ts 冒頭のコメントで `--port 0` を「正当な起動パターン」と明記していたのに、AC-5 の文言だけがそれと矛盾していた（設計メモ内の自己矛盾）。「メモが正」という指示より「verify.sh を壊さない」という NFR-2 上位の信頼性制約を優先し、コード内コメント + 完了報告の両方に逸脱を明記する方針を採った。**次にこの手の矛盾を見つけたら、まず `grep -rn` で既存スクリプト・memory の実依存を確認してから、メモの字面より実挙動保存を優先してよい**（今回はオーケストレータへの報告で承認された前提だが、無断で暗黙修正はしない）。

**fs facade（`SeqWriteFsFacade`）の `writeFileSync?` は意図的に未使用のまま残した**: 設計メモが facade の shape を `{ writeFileSync?, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync }` と明記していたが、実装は `openSync→writeSync→fsyncSync→closeSync→renameSync`（1 つの fd を書き込みから fsync まで使い回す標準的な atomic-write パターン）に一本化し、`writeFileSync` は呼ばない。`?`（optional）だけ他と違う理由を「テストダブルが省略してよい＝呼ばれない」の合図と解釈し、分岐を増やさない選択をした。両方の解釈が成り立つ曖昧な facade shape 記述に出会ったら、**複雑な分岐を増やさない側の解釈を取り、コード内コメントで解釈の理由を明示する**のが正解だった（office-qa の複雑性懸念を避けられた）。

**cli.ts の「import 時副作用ゼロ」は `main()` 内で全 deps を遅延解決することで達成**: `createRelayRuntime(deps: RelayRuntimeDeps)`（deps は完全指定、テスト用）と `main(overrides: Partial<RelayRuntimeDeps> = {})`（`process.argv`/`process.env`/実 `serve`/`process.exit` 等をこの関数の呼び出し時点で解決し `createRelayRuntime` に渡す）を分離した。**モジュールトップレベルで `process.argv.slice(2)` のような一見無害な読み取りすら定数化してはいけない**（`const defaultDeps = {argv: process.argv.slice(2), ...}` を module scope に置くと import だけで評価される）。is-main ガード（`realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)`、先例 `packages/cc-sier-adapter/src/cli.ts`）は `main()` の外側に置き、ガードが true のときだけ `main()` を呼ぶ。

**`deps.serve` の型は `typeof serve`（`@hono/node-server` から import した実関数の型）をそのまま使うのが正解**: 独自の narrow interface を定義すると `Options`/`FetchCallback`/`AddressInfo`/`ServerType` との構造的互換性を毎回手動で確認する羽目になる。`typeof serve` を使えば default 値（本物の `serve`）は無条件で型が合い、テスト側だけ戻り値オブジェクト（`{on: vi.fn(), close: vi.fn()}`）を `as unknown as ServerType` でキャストすればよい（Node の `net.Server` 系フル実装は不要）。

**console.log/error/warn は DI せず直接呼び、テストは `vi.spyOn(console, "error").mockImplementation(() => {})` で潰す**方針を踏襲した（buffer.ts/server.ts/seq.ts の既存慣習と統一。deps interface を `{log,error,warn}` まで膨らませなかった）。設計メモの dep 一覧が `{ serve, exit, setTimeout, onSignal, now? }` 等（"等" で非網羅を明示）だったので、この判断は memo の想定範囲内。

**graceful shutdown（AC-6）の再入ガードは `shuttingDown` フラグ + 2 度目 signal で `deps.exit(1)` 即終了**、1 度目は `buffer.size()>0` warn → `deps.setTimeout(()=>deps.exit(0), 5000).unref?.()`（強制ガード）→ `server.close(() => deps.exit(0))`。テストは「close がコールバックを一切呼ばずハングする偽 server」と「close がコールバックを保持するだけで呼ばない偽 server」の 2 種類の fake を使い分けて、強制ガード発火経路と再入ガード経路をそれぞれ実時間 sleep 無しで検証した（buffer.test.ts の manual timer 技法 [[m1-2a-relay-persistence]] を cli.test.ts にも展開）。

**検証の切り分け**: `pnpm --filter @ai-office/relay test`（162 pass）と `pnpm --filter @ai-office/relay typecheck`・`build`（いずれも `**/*.test.ts` を除外する tsconfig）はクリーンだったが、念のため一時 tsconfig（`include: ["src"]` のみ、test 込み）で厳密チェックしたところ `seq.test.ts`/`server.test.ts` に**既存の**（今回の変更と無関係な）`Math.max(...possiblyUndefinedArray)` 系の緩い型エラーが 2 件見つかった。CI の `pnpm -r typecheck` はテストファイルを対象外にしているため表面化しない。**触っていないファイルの pre-existing な型の緩さは、スコープ外として報告のみに留め、無断で直さない**（今回は正しい判断だった）。一時 tsconfig は使用後に確実に削除すること（`dist-fulltest-tmp` ディレクトリも道連れで作られる）。

**verify.sh は今回実行していない**（`pnpm -r run build` を内部で呼ぶため、担当外スコープ + dogfooding 稼働中という制約から Phase 2 では見送り、Phase 3/オーケストレータ判断に委ねた）。ただし `pnpm --filter @ai-office/relay build` は実行済みで、dist/cli.js は再生成された。**稼働中の dogfooding relay プロセス（`node packages/relay/dist/cli.js`）は dist ファイルを上書きしても影響を受けない**（Node は import 時にファイル内容をメモリに読み込み済みで、disk 上の再ビルドは既存プロセスに波及しない）ことを `/health` の実叩きで確認済み。ビルド確認をする際にこの安全性を毎回気にする必要はない。
