---
name: hooks-normalize-test-cases
description: apps/web/lib/normalize.test.ts に必須の機微情報漏洩検出ケース一覧（M0 で確立、以後の変更でも維持すべき）
metadata:
  type: project
---

M0（イベントパイプライン ingest/SSE/正規化）の TDD で `apps/web/lib/normalize.test.ts` に以下のケースを揃えた。`packages/protocol` 抽出後や新イベント種別追加時にも、この一式は削らずに引き継ぐこと。

**Why:** 単に「フィールドが存在しないこと」を assert するテストだけだと、実装が別名フィールド（例: `filePath` を `path` にリネームして漏らす等）で機微情報を残しても検出できない。文字列断片ベースの assertion を混ぜることで NFR-4 の実効性を担保している。

**How to apply:** 新しい正規化ロジックを追加するときは、最低限この観点を維持する。
- PreToolUse(Edit) で `file_path` の絶対パス・`content` が出力 JSON 文字列に一切含まれないこと（`toContain` の否定で確認、ディレクトリ名の断片単位でチェック）
- UserPromptSubmit の `prompt` 本文が含まれないこと
- Bash の `command` が含まれないこと
- Task の `subagent_type` は残るが、同時に渡した `tool_input.prompt` は含まれないこと（サブエージェント起動時にプロンプトも一緒に来るケースの防御）
- `cwd` / `transcript_path` が含まれないこと
- 未知の `hook_event_name` → null、`session_id` 欠落 → null、`raw` が非 object（文字列・null・数値・配列）→ null
- `ts` が呼び出し引数 `now` と一致すること（関数内で `Date.now()` を呼んでいないことの間接検証）
- `file_path` がバックスラッシュ区切り（Windows パス）でもベース名のみになること

実装ファイルは `apps/web/lib/normalize.ts`（`normalizeHookEvent`）。スキーマは `apps/web/game/protocol.ts` の `OfficeEventSchema`（M1 で `packages/protocol` へ抽出予定、[[normalize-whitelist-pattern]] 参照）。
