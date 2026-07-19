---
name: office-verify
description: >
  ai-virtual-office の停止条件スキル。「動作確認」「verify」「検証して」と言われたとき、
  または office-qa / /goal の検証条件として、scripts/verify.sh を実行し exit code で
  機械的に合否を判定する。LLM の目視判断を挟まない。
---

## ギャップ記録（このスキルが無いと起きる失敗）

<!-- 本文を書く前に、スキルなしで実際に失敗した具体例を 3 件記録する。
     3 件集まるまで本文は最小限（手順の骨子のみ）に留める（設計書 §3.2） -->

1. [2026-07-XX] （未記録）
2. [2026-07-XX] （未記録）
3. [2026-07-XX] （未記録）

**運用注記**: 実失敗が 3 件集まるまで本文を太らせない。失敗が起きたら日付・何をどう間違えたかをこの欄に追記してから、必要最小限の手順だけを本文に足す。

## 手順

1. リポジトリルートで検証スクリプトを実行する:

   ```bash
   bash .claude/skills/office-verify/scripts/verify.sh
   ```

2. **exit 0 = 合格 / 非 0 = 不合格**。不合格時は stderr の失敗ステップを修正し、再実行する。目視での「動いていそう」判断で合格扱いにしない。

## 現時点の検証範囲（M0 骨格版）

- pnpm / `pnpm install` の成否確認
- 各 workspace パッケージに `build` / `typecheck` スクリプトが定義されていれば実行

以下は **M1 で実装**（verify.sh 内に TODO 明記済み。未実装ステップは合否に含めない）:

- Relay 起動（バックグラウンド）
- fixture イベント注入（`POST /test/inject`）
- Debug State API（`window.__OFFICE_DEBUG__`）による描画状態 assert
