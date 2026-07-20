---
name: m1-2a-relay-persistence
description: packages/relay に seq 永続採番 + forward 契約変更(Promise<boolean>) + 再送バッファ(buffer.ts)を TDD 追加した際の設計判断・テスト技法
metadata:
  type: project
---

M1-2a（`feat/2026-07-20-m1-2a-persistence` ブランチ）で `packages/relay/` に永続化層を TDD 追加した際の判断ログ。設計メモは rev.3（人間承認済み、N-1〜N-3 対応）。[[m1-1-relay-creation]] の続き。67 テスト green（45 既存 + 22 追加）、typecheck/build とも exit 0。

**forward.ts の契約変更で `Forwarder`(`Promise<boolean>`) と server.ts の `EventSink`(`Promise<void>`) を意図的に別の型として分離した**。最初 server.ts の `forward` フィールドをそのまま `Forwarder` 型に追従させようとしたが、それだと既存 `server.test.ts` の `defaultForward`（`Promise<void>` を返す既存モック）や「forward が reject する」テストが軒並み型エラーになり、無関係な既存テストを書き換える羽目になる。**server 層は「成否を気にせず呼べば必ず解決する」契約（旧 Forwarder と同じ shape）のままにし、成否判定・再送は `buffer.ts` の `RetryBuffer#send` に閉じ込める**のが正解だった。`cli.ts` で `forward: buffer.send`（`RetryBuffer.send: (event) => Promise<void>`）を注入することで、server.ts 側のコード・テストはほぼ無改修で済んだ（追加した2テストのみ）。今後 protocol/relay の契約を変える際は「型を素直に伝播させる」より先に「どのレイヤーがその型変更の影響を吸収すべきか」を考えること。

**seq.ts のブロック予約: 「ファイルが存在しない」と「読み取り失敗」を明確に区別する**。`readFileSync` の `ENOENT` は「初回起動で正常」（lastSeq=0 とみなす）、それ以外の throw（権限・破損 JSON）は「失敗」として扱い `undefined` を返す。この区別を怠ると初回起動が常に undefined になってしまう。また **失敗を「永続的に壊れた」状態にせず、次回呼び出しで再度予約を試みる**設計にした（`current`/`blockEnd` を更新しないまま return するだけ。broken フラグのような永続状態は持たない）。一時的な障害（ディスク一時逼迫など）からの自己回復を可能にするための判断で、テスト `retries reservation on a later call after a transient failure recovers` で担保した。

**buffer.ts の再送タイマーテスト技法（sleep 無し・型的にも安全）**: `ScheduleTimer = (fn: () => void, ms: number) => void` という型のまま、実装側は内部で `async () => { ...; await drain(); }` を渡している。TypeScript は「対象の返り値が `void` のとき呼び出し元は実際の返り値を何であれ受け入れる」という仕様があるため、これは型エラーにならない。テスト用の手動タイマー（`makeManualTimer`）はランタイムでは実際に Promise が返ってくることを利用し、`await next.fn()` として drain の完了を確定的に待つ（TS の型注釈は消去されるため `await` 自体はコンパイルエラーにならない）。real timer/sleep を一切使わずに「バッファが空になるまで順次ドレインする」「指数バックオフの間隔」を決定論的に検証できた。この技法は今後 DI されたコールバック型が `void` 固定でもテスト側だけ非同期完了を待ちたい場面で再利用できる。

**head-of-line 非採用の実装は極めてシンプル**: `send()` はバッファの状態を一切見ず「常に forward を直接呼ぶ→false なら enqueue」だけ。バッファの中身と新規イベントの直送は完全に独立しており、`queue.length` による分岐すら不要だった（最初の設計案にあった `if (queue.length === 0)` 分岐は削除して正解）。この単純さのおかげで NFR-1（1 秒以内反映）を守れていることをコードだけで説明しやすい。

**maxSize 超過時のドロップ確認テストのコツ**: バッファ内部の配列を外部公開せず（`size()` のみ公開）、"どのイベントが捨てられたか" を検証したい場合は、後で forward を成功に切り替えてドレインさせ、`forward.mock.calls` に記録された順序・sessionId で間接的に確認する。内部状態を晒す `peek()`/`list()` のような API を追加する必要はなかった。

**本番非破壊の検証方法**: `~/.ai-office/relay-seq.json` が作業前後で存在しないことを `stat` で確認。全テストは `mkdtempSync(join(tmpdir(), "ai-office-relay-seq-test-"))` で作った一時ディレクトリのみを使い、`resolveSeqPath()` 自体のテストも実際の I/O は発生させていない（パス文字列を返すだけの純関数として検証）。cli.ts を実プロセスとして起動する検証はこのタスクでは実施していない（TDD ユニットテストのみ、AC-9 は対象外）。

次サイクル（M1-2a の残り、担当外）: apps/web 側の SQLite 永続化・`event: restore` SSE 配信、game-engine-dev 側の順序防御（office-state.ts の tombstone 化含む、並行実装済みの模様）。関連: [[m1-1-relay-creation]] [[m1-1-protocol-extraction]]
