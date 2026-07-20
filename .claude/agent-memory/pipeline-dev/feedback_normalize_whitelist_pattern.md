---
name: normalize-whitelist-pattern
description: normalizeHookEvent (apps/web/lib/normalize.ts) の機微情報フィルタ実装パターンとテスト観点
metadata:
  type: feedback
---

`normalizeHookEvent(raw: unknown, now: number)` は **ホワイトリスト方式**で実装する（ブラックリストで特定フィールドを消す方式は禁止）。出力オブジェクトを最初から `{ type, sessionId, ts, ...(toolName), ...(fileBase), ...(subagentType) }` の形で組み立て、`raw` の他フィールド（`prompt` / `tool_input.content` / `tool_input.command` / `cwd` / `transcript_path` / `message` 等）には一切アクセスしない。

**Why:** ブラックリスト方式（受け取った object から機微フィールドを delete する）だと、Claude Code hooks の stdin JSON にフィールドが将来追加されたときに新しい機微情報がフィルタを素通りしてクラウドに漏れるリスクがある（NFR-4 の要求は「保存してよいものだけを明示的に列挙する」）。ホワイトリスト方式なら新フィールド追加時に自動的に除外される。

**How to apply:**
- 新しい hook イベント種別やツールを追加する際も、`record.<field>` へのアクセスを増やすときは「本当にホワイトリストに載せてよい情報か」を都度確認する。
- テストは「特定フィールドが存在しないこと」だけでなく `JSON.stringify(result)` に機微な**文字列断片**（`SECRET` / パス中のディレクトリ名 / コマンド文字列）が含まれないことを assert する形にすると、フィールド名を変えて漏らす手口も検出できる（[[hooks-normalize-test-cases]] 参照）。
- `tool_input.file_path` は `/` と `\\` の両方をセパレータとして扱い、ベース名のみを残す（Windows パス対策）。`split(/[\\/]/)` で十分。
- `tool_input` が object でない・存在しない場合（例: PostToolUse に tool_input がない）でも例外を投げず `fileBase`/`subagentType` を undefined のままにする。
