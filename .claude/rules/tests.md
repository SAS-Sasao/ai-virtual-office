---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
---

# テストルール（*.test.* / *.spec.*）

1. **テスト弱体化の禁止**: assertion の削除、`.skip` / `.only` / `test.fixme` の追加は、①理由の明示 ②対応する受入基準の変更提示、の両方なしに行わない。無断の弱体化は office-qa レビューで s3 = 0（即 fail）になる
2. **TDD 順序**: 受入基準から失敗するテストを先に書き（red）、実装で green にする。実装後にテストを書かない
3. **E2E の決定論性**（設計書 §5）:
   - 時間依存の `sleep` / 固定待ち時間を使わない。同期は `waitForIdle()` で行う
   - fixture はシード付き（`fixtures/e2e/*.jsonl`）。実セッション依存のテストを書かない
   - `?e2e=1` fast-mode を前提にする（アニメーション 0 化・固定 tick）
   - **ピクセルではなく状態を assert する**（Debug State API が主、`toHaveScreenshot` は従・非ブロッキング）
4. `@smoke` タグは M0/M1 受入基準の直訳のみに付与し、スイート全体で 60 秒予算を守る
5. フレークを見つけたら放置しない: 原因は決定論性ルール違反をまず疑い、`@quarantine` → 根治 → タグ除去の順で扱う
