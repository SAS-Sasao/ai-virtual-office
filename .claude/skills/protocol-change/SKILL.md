---
name: protocol-change
description: >
  packages/protocol（Zod イベントスキーマの唯一の正本）を変更するときの手順スキル。
  「イベント追加」「スキーマ変更」「protocol」「OfficeEvent にフィールドを足す」と
  依頼されたときに使用する。gate-protocol-consumers hook と対になる「正しいやり方」。
---

## ギャップ記録（このスキルが無いと起きる失敗）

<!-- 本文を書く前に、スキルなしで実際に失敗した具体例を 3 件記録する。
     3 件集まるまで本文は最小限（手順の骨子のみ）に留める（設計書 §3.2） -->

1. [2026-07-XX] （未記録）
2. [2026-07-XX] （未記録）
3. [2026-07-XX] （未記録）

**運用注記**: 実失敗が 3 件集まるまで本文を太らせない。失敗が起きたら日付・何をどう間違えたかをこの欄に追記してから、必要最小限の手順だけを本文に足す。

## 手順

1. **正本のみを編集する**: スキーマ定義は `packages/protocol/src/events.ts` にしかない。消費側（`apps/web`、`packages/relay`）で型を再定義せず、`z.infer` による導出のみ行う
2. **テストを先に更新する**: `packages/protocol/src/events.test.ts` に新フィールドの正常系・異常系（型違反・境界値）を追加し、red を確認してからスキーマを変更する
3. **semver 判断**: イベント種別の追加 = minor / 既存フィールドの型変更・必須化 = major。optional フィールドの追加は minor。判断結果を PR 本文に書く
4. **ビルドして dist を更新する**: `pnpm --filter @ai-office/protocol build`（消費側は dist を参照するため、build を忘れると型エラーになる）
5. **両系テストを実行する**（規約。gate-protocol-consumers が Stop 時に機械的に強制する）:

   ```bash
   pnpm --filter @ai-office/relay test -- --run
   pnpm --filter web test -- --run
   ```

   （`--` の後が vitest へ渡る。`--` を付けずに `--run` を書くと pnpm が
   `Unknown option: 'run'` で失敗するので注意）

6. **機微情報の再確認（NFR-4）**: 新フィールドがプロンプト本文・ファイル内容・URL・cwd 等を運ばないことを確認する。運ぶ場合は `packages/relay/src/normalize.ts` のホワイトリストに入れてはならない
7. **fixture の更新**: `POST /test/inject` に投げる fixture（E2E 導入後は `fixtures/e2e/*.jsonl`）を新スキーマに合わせる

## 注意

- `OfficeEvent` の順序規約: 消費側は `seq` があれば seq 昇順、無ければ `ts` 昇順で扱う。`seq` は Relay プロセス内の単調増加であり、Relay 再起動をまたぐ単調性は保証しない（永続採番は M1-2）
- `state` はイベントに持たせない（`mapping.toolToState` で導出する派生値）
- `org` / `dept` / `role` は帰属推定（M1-3）と同時に追加する
