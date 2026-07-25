---
name: m1-3-carryover-fixes
description: M1-3冒頭で消化したM1-2a/M1-2b繰り越し6件(apps/webカバレッジ3件+packages/cliバグ3件)のTDD記録と、vi.spyOnがESM named importに効く確認
metadata:
  type: project
---

M1-3 サイクル冒頭（`feat/2026-07-25-m1-3-adapter` ブランチ）で、前2サイクルの office-qa レビューが「次サイクル冒頭で対応」と指定した繰り越し6件を TDD で消化した記録。251→265テスト（apps/web 56→64、cli 106→112）。typecheck・build とも exit 0。関連: [[m1-2a-web-db-persistence]] [[m1-2b-cli-setup-doctor-teardown]]

**apps/web の3件（ingest DB結線・stream回帰・prune-on-init）は全て「red 無しでいきなり green」だった**: これは m1-2a/m1-2b で「実機では動作確認済み」と報告されていた実装のカバレッジの穴を埋める作業であり、実装自体に不具合は無かった。TDD の型どおり「まずテストを書いて red を確認」を試みたが、いずれも初回実行で green になった。**教訓**: 前サイクルの「実機で確認済みだがユニットテストが無い」という報告は、今回に関しては信頼できる報告だった（虚偽や楽観的すぎる報告ではなかった）。ただし `packages/cli` 側の3件（後述）は逆に全て実際にバグがあり red を再現できたため、**「カバレッジの穴」と「未検証の疑わしい挙動」は指示文の書き分けどおり別種のタスクとして扱ってよい**（前者は red が出なくても手戻りではない）。

**`vi.spyOn(namespaceImport, "exportName")` は Next.js(apps/web) にも packages/cli にも、vitest 環境で ESM の named import を問題なく差し替えられる**: `import * as dbClient from "../../../db/client"; vi.spyOn(dbClient, "getDb").mockReturnValue(null);` として、route.ts 側が `import { getDb } from "../../../db/client"` と named import していても、spy が効く（Vite/Vitest の SSR 変換が両方の import を同一の exports オブジェクトへの参照にするため）。本リポジトリでこのパターンが使われたのは今回が初めて（`packages/relay/src/buffer.test.ts` の `console.warn` spy 以外に前例が無かった）。`insertEvent` throw のシミュレーションも同様に `vi.spyOn(dbEvents, "insertEvent").mockImplementation(() => { throw ... })` で機能した。**モジュール全体を `vi.mock()` で差し替えるより軽量**なので、「DB 層が失敗しても ingest は 200 を返す」系の防御コードをテストする際の第一選択にしてよい。

**`GET(): Promise<Response>` の中に `await` が1つも無ければ、呼び出しは完全に同期的に完了する**: `apps/web/app/api/stream/route.ts` の `GET` は `async function` だが本体に `await` が無いため、`await GET()` を待つまでもなく、呼び出した瞬間に `new ReadableStream({start(){...}})` の `start()`（hello enqueue → DB からの restore 読み込み・enqueue → `subscribe()`）が同期的に全て完了する。これを利用し、`const res = await GET(); publish(liveEvent);` という順序で書くだけで「hello → restore → subscribe」の順序を sleep 無しに固定できた（`publish` は同期的にリスナーを呼ぶため、GET() 直後に呼んでも「subscribe 後」に確実に届く）。SSE の消費は `res.body!.getReader()` + 手動で `\n\n` 区切りをパースし、必要フレーム数を集めたら `reader.cancel()` で `route.ts` の `cancel()` ハンドラ（`unsubscribe()` + `clearInterval(heartbeat)`）を発火させてタイマーリークを防ぐ。この形なら実サーバ起動もタイムアウトも不要。

**`getDb(path)` は `path` 引数で DI 可能なので、`AI_OFFICE_DB_PATH` 環境変数を書き換えなくても prune-on-init のファイル DB テストが書ける**: `apps/web/vitest.config.ts` はテストプロセス全体を `AI_OFFICE_DB_PATH=":memory:"` に固定しているため、env 経由でファイルパスに切り替えるのは危険（他テストファイルへの汚染リスク）。代わりに `getDb(mktempPath)` と明示的にパスを渡し、`resetDbSingletonForTests()` で「1回目の接続（seed）→ reset → 2回目の接続（prune 実行）」を再現した。実際に `console.log("web: pruned 1 event(s) older than 30 days on db init")` が出力されることまで確認済み（m1-2a-web-db-persistence が「見送った」としていたテストを今回追加）。

## packages/cli の3件（実際にバグがあり red を再現できた）

**finding: `mergeHooks` の冪等判定(`alreadyOurs`)は「最初に見つかった非空グループ」だけを見ると壊れる**: 同一 matcher の非空グループが複数存在し得る（finding9 対応で CLI 自身のグループを既存の空グループとは別に新規作成するため、後からユーザーがどちらかに手書き追記すると複数の非空グループが並存する）。旧実装は `matchingGroups.find(hasContent)` で得た**1個のグループの中だけ**で `alreadyOurs` を判定していたため、自分のマーカー付きエントリが2つ目以降のグループにあると誤って「無い」と判定し、1つ目のグループに2本目を追加してしまう。**修正**: `hasUnmarkedDuplicate` と同じ横断パターンで `matchingGroups.some(...)` に変更（`packages/cli/src/merge.ts`、`targetGroup` を選ぶ前に判定するよう並び替えた）。

**finding: 二重送信検知(`hasUnmarkedDuplicate`)の URL 部分文字列一致が緩すぎる**: `command.includes(url)` だけでは `echo "see http://localhost:4100/hooks/stop"` のような「URL に言及するだけで実際には POST しない」コマンドまで「配線済み」と誤認し、CLI が自分のフックを追加しなくなる（本来は追加すべきなのに `skippedDuplicateSlugs` に入ってしまう）。**修正**: `targetsUrlViaPost(command, url)` ヘルパーを新設し、`command.includes(url) && command.includes("curl") && command.includes("-X POST")` の3条件を要求するようにした。既存の `AC-11b`（本物の curl -X POST コマンドでの重複検知）は curl+POST を含むので回帰しない。

**finding: doctor レポートの内訳合計が 8 に満たないことがある(malformed の欠落)**: `mergeHooks` は `skippedMalformedSlugs` を返すが、`doctor.ts` の `DoctorHooksStatus` にはそれを反映するフィールドが無く、`installedSlugs + duplicateSlugs + missingSlugs` の合計が malformed な slug の分だけ 8 に届かなくなっていた（数字上どこにも計上されない）。**修正**: `DoctorHooksStatus` に `malformedSlugs: string[]` を追加し `dryRun.skippedMalformedSlugs` をそのまま反映。`inspectScope` の parseError/not-exists の早期 return にも `malformedSlugs: []` を追加（TypeScript の必須プロパティチェックで機械的に強制された。`typecheck-touched.sh` hook が3箇所の抜けを即座に検出した）。`index.ts` の `formatDoctorReport` にも malformed 警告行を追加し、**テストのために `formatDoctorReport` を export した**（元は非 export のプライベート関数）。「内訳の総和は常に8」を固定するテストは `doctor.test.ts` に2本（malformed あり／無しの両方）追加し、`missingSlugs`（= `addedSlugs`、値は "would add if setup ran now"）を含めた4分類の合計で検証した。

関連: [[m1-2a-web-db-persistence]] [[m1-2a-relay-persistence]] [[m1-2b-cli-setup-doctor-teardown]]
