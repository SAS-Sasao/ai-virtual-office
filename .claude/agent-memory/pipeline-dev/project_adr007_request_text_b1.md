---
name: project_adr007_request_text_b1
description: ADR-007 実装 (b)-1 protocol+relay サイクル — requestText 追加の設計判断・テスト境界の分担・弱体化でない書き換えの通し方
metadata:
  type: project
---

2026-08-16、ADR-007（NFR-4 二層化: ローカルは依頼文保持・クラウド転送で破棄）の実装第 1 弾として、`OfficeEvent.requestText`（optional string）を protocol/relay に追加した（web 表示は Phase 2b で別担当）。

**Why:** ユーザーの最終像「各サブエージェントが何を実装しているか / 作業依頼をダッシュボード表示」を実現するため、依頼文本文だけを [[feedback_normalize_whitelist_pattern|normalize のホワイトリスト方式]] の例外として通す必要があった。ただし NFR-4 の「クラウドに本文を送らない」保証は死守する必要があり、二層化（ローカル保持 / クラウド境界 strip）で両立させた。

**How to apply（次に protocol にローカル限定フィールドを足すときの型）:**
- **抽出スコープを型レベルでなく if 文で厳密に絞る**: `normalize.ts` では `type === "user_prompt"` の `record.prompt` と `type === "pre_tool" && toolName === "Task"` の `tool_input.prompt` の 2 パスだけに `toRequestText()`（非文字列/空文字→undefined、`MAX_REQUEST_TEXT_LEN`=2000 で切り詰め）を適用した。Task 以外の pre_tool や tool_input.prompt 以外のキーからは一切読まない。この「どこから読んでよいか」を狭く保つのが NFR-4 のスコープ管理の要。
- **クラウド境界の strip は relay 側に純関数として置く**: `forward.ts` に `stripCloudSensitive(event): OfficeEvent`（`{requestText, ...rest} = event` で新オブジェクトを返す・元は不変）を追加。**現サイクルではクラウド forwarder 自体は未実装**なので `stripCloudSensitive` は呼び出されていない ready seam（M3 で適用）。呼ばれていない関数でも「テストで存在を担保する」ことで NFR-4 のクラウド保証を先に固定できる。
- **テスト境界を明確に分担する**（正本レビューで指摘された重要ポイント）: 「本文がクラウドに漏れない」ことの assertion は `forward.test.ts`（`stripCloudSensitive` の AC-6）に**一元化**し、`normalize.test.ts` は「ローカルは正しく抽出される（positive）」+「依頼文でないもの（Bash command 等）は決して載らない（AC-4 敵対的テスト）」に専念させた。`normalize.test.ts` から `forward.ts` を import しない（テスト境界の重複・密結合を避ける）。
- **既存テストの「正当な書き換え」を弱体化と区別してどう通すか**: `normalize.test.ts` の旧 2 テスト（"プロンプト本文は出力に含まれない" 系）は、ADR-007 でローカル仕様そのものが変わるため書き換えが必須だった。tests.md §1 の要求（①理由 ②対応 AC）を満たすため、テスト名自体を「requestText に載る（ローカル保持・AC-2/AC-3）」に変え、assertion を `not.toContain` から `toBe("<期待する本文>")` の positive assertion に転換した。**delete ではなく再ターゲット**という枠組みで、非漏洩の保証は forward.test.ts 側へ移した。この 2 件以外（Bash command・cwd/transcript_path のテスト）は無改修で維持し、「本文でないものは今後も一切載らない」という恒久保証を切り分けて残した。
- **red→green の確認順序**: protocol (events.test.ts) → build (`pnpm --filter @ai-office/protocol build`) → relay normalize → relay forward → 両系フルテスト → typecheck、の順で通した。protocol の dist を build し忘れると relay/web 側の消費テストが古い型のまま偽 green になるので、必ず build を挟んでから次に進む。

**環境メモ**: このサイクル中、`packages/relay` の `server.test.ts`（"normalize が null を返すイベントでは receivedCount が増えない"）が 1 回だけ 5000ms タイムアウトで落ちたが、リトライで通った。[[project_web_db_durability_cycle2b]] に記録済みの「この環境で約 1/10 発生する pre-existing flake」と同種で、今回の変更とは無関係（該当テストは requestText と無関係なコードパスのみに依存）。
