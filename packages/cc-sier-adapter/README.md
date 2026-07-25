# packages/cc-sier-adapter

CC-SIer の `masters/*.md` を `OfficeLayout` / `Character` JSON へ、`.task-log/*.md` を `OfficeEvent[]`（リプレイ用）へ変換するアダプタ。境界の詳細は `docs/design/architecture-design.md` §10、帰属推定は要件 FR-4 を参照。

## CLI（M1-3 実装済み）

```bash
pnpm --filter @ai-office/cc-sier-adapter build
ai-office-adapter import [--repo <path>] [--out <dir>] [--dry-run]
```

- `--repo` 省略時は `~/.ai-office/config.json` の `organizations[]`（`type: "cc-sier"`）を読む（読むだけで書き込まない）
- 出力先は `--out` > `AI_OFFICE_LAYOUTS_DIR` > `~/.ai-office/layouts/` の順で決定し、`office-layout.json` / `characters.json` / `attribution.json` を生成する
- 再実行は冪等。既存出力に `custom: true` を付けた room/furniture は上書きされない
- 生成失敗時（masters が壊れている・0 部署）は既存出力を一切書き換えず、非 0 終了する（graceful degradation）

## モジュール構成

| ファイル | 責務 |
|---|---|
| `src/parse-masters.ts` | `masters/*.md` の純関数パーサ（`## <id>` セクション分割・キー/値抽出） |
| `src/import-org.ts` | masters の中間表現 → `OfficeLayout` + `Character[]`（レイアウト自動生成・custom 温存） |
| `src/attribution-index.ts` | `attribution.json`（帰属インデックス）の生成。実行時 lookup は `packages/relay/src/attribute.ts` が担う |
| `src/cli.ts` | `ai-office-adapter import` 本体（fs I/O はここと `fs-io.ts` に閉じ込める） |
| `src/import-tasklog.ts` | `.task-log/*.md` → `OfficeEvent[]`（リプレイ用。M2 で実装予定、本サイクルはスコープ外） |

`~/.claude/settings.json` を書き換える力は無く、CC-SIer の生データは一切アプリ本体（`apps/web` / `packages/relay` / `packages/protocol`）へ持ち込まない（境界を守るのは本パッケージの責務）。
