---
name: web-db-durability-cycle2b
description: apps/web/db WAL+PRAGMA pin・定期prune(注入now)・loadRecentSessionsのmaxSessions実装で踏んだ落とし穴とvitestフレークの切り分け法
metadata:
  type: project
---

サイクル2b（バックエンド堅牢化）で `apps/web/db/client.ts`（WAL/PRAGMA pin + 定期 prune）と
`apps/web/db/events.ts`（`loadRecentSessions` の `maxSessions`）を TDD で実装した際の記録。
設計メモは `docs/design/decision-log.md` には未収録（scratchpad の使い捨てメモ）。関連: [[m1-2a-web-db-persistence]]。

## `db.$client` は型に無くても実行時には存在する（drizzle-orm 0.44.7 + better-sqlite3）

`export type Db = BetterSQLite3Database<typeof schema>` は交差型 `& { $client: Database }` を
剥がすため `db.$client` は素では **TS2339**。だが drizzle は実行時に必ず `$client` に raw
better-sqlite3 ハンドルを代入している。テストだけでなく**プロダクションコード側**でも
（`runWalCheckpoint` で `wal_checkpoint(TRUNCATE)` を発行するために）同じキャストパターンを
使ってよい:

```ts
(db as unknown as { $client: import("better-sqlite3").Database }).$client
```

プロダクション型 `Db` 自体は変えない（`$client` を呼び出し側全般に広く露出させたくないため、
使う箇所だけ局所的にキャストする）。

## per-connection の PRAGMA は「同じ接続」からしか読み戻せない

`journal_mode=WAL` はファイル永続（別接続で開き直しても 'wal' が返る）だが、
`busy_timeout` / `synchronous` は**接続ごと**でファイルに残らない。開き直した別接続で読むと
既定値（`busy_timeout` はコンストラクタ既定 5000 なので偶然一致し得るが `synchronous` の既定は
FULL=2 で NORMAL=1 と食い違う）を見てしまい、テストの意味が失われる。`createDb` が開いた
まさにその接続のハンドルから読み戻すこと。

## singleton wrapper を discriminated union にすると「null に余分な状態を持たせない」が型で強制される

`getDb` の 2 回目以降呼び出しで throttle 判定するための `lastPruneAt` を素朴に
`{ db: Db | null; lastPruneAt: number }` で持つと、接続失敗時（`db: null`）にも
`lastPruneAt` を書ける／読める余地が残る。設計メモは「null は lastPruneAt を持たない」と
明記していたので、`type DbSingletonWrapper = { db: Db; lastPruneAt: number } | { db: null }`
という判別共用体にしたところ、`db: null` 側に `lastPruneAt` を代入しようとした初期実装が
**TS2353 でコンパイルエラーになり、実装ミスをその場で検出できた**。null-cache 経路の契約を
テストだけでなく型でも縛りたい場合はこのパターンが有効。

## `loadRecentSessions` の `maxSessions` cap は独自の ts ソートではなく `compareOrder` を再利用する

fold 後（latest-per-session）の Map を「最新順に maxSessions 件」に切り詰める際、単純に
`ts` で降順ソートすると、既存の「seq 優先・片方欠落なら ts」という順序規約（`compareOrder`）
とずれる（同一 ts で seq だけ違う行が複数セッションの最新行として並ぶケースで矛盾し得る）。
`capped = [...map.values()].sort((a,b) => compareOrder(toOrderKey(b), toOrderKey(a))).slice(0, maxSessions)`
のように既存の `compareOrder` をそのまま降順で使うことで、fold と cap の「最新」の定義を
一致させた。

## vitest の 5000ms タイムアウトはこのサンドボックス環境で約 1/10 の頻度で pre-existing flake する

`pnpm --filter web test` を連続実行すると、**変更を一切加えていない main ブランチでも**
約 10 回に 1 回、無関係な複数テストファイル（`app/api/health/route.test.ts` /
`app/api/stream/route.test.ts` / `app/api/ingest/route.test.ts` など）で
`Test timed out in 5000ms` が同時多発することを確認した（`git stash` で変更を退避し
baseline のみで 10 回実行し再現）。原因はサンドボックスのリソース競合と推測され、
テストロジックのバグではない。**新規追加テストで単発の 5000ms タイムアウトを見ても、
即座に自分の実装を疑う前に `git stash` でベースラインとの比較実行を行い、無関係な既存
テストも同時に落ちていないか確認すること**（無関係なファイルも同時に落ちていれば環境要因）。
単一スレッド実行（`--pool=threads --poolOptions.threads.singleThread`）でも完全には消えない。
