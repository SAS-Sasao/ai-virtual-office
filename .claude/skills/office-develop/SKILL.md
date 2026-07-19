---
name: office-develop
description: >
  ai-virtual-office の開発サイクル（オーケストレータ）スキル。「開発して」「機能追加」
  「開発サイクル」と依頼されたとき、設計 → 設計レビュー → 実装（TDD）→ 実装レビュー →
  E2E → 反映の 6 フェーズを統合実行する。各レビューゲートは office-qa の verdict JSON で
  合否判定し、fail は前フェーズへループする。
---

## ギャップ記録（このスキルが無いと起きる失敗）

<!-- 本文を書く前に、スキルなしで実際に失敗した具体例を 3 件記録する。
     3 件集まるまで本文は最小限（手順の骨子のみ）に留める（設計書 §3.2） -->

1. [2026-07-XX] （未記録）
2. [2026-07-XX] （未記録）
3. [2026-07-XX] （未記録）

**運用注記**: 実失敗が 3 件集まるまで本文を太らせない。失敗が起きたら日付・何をどう間違えたかをこの欄に追記してから、必要最小限の手順だけを本文に足す。

## 開発サイクル（設計書 §3.4）

### Phase 0 設計

担当 maker（game-engine-dev / pipeline-dev / ui-dev / org-adapter-dev のうち対象モジュールの担当）が**変更設計メモ**を起案する。必須項目: 対象モジュール / 受入基準 / テスト方針 / 影響範囲。

### Phase 1 設計レビュー

office-qa を Task で起動し、変更設計メモを設計書 §4.1 基準で採点させ、**verdict JSON を取得**する。

- fail → findings を添えて Phase 0 へ差し戻し。**自動リトライは 1 回**。2 回目の fail で人間へエスカレーション

### Phase 2 実装（TDD）

受入基準から**失敗するテストを先に書き（red）**、実装で green にする。PostToolUse 検証 hooks（guard-game-react / typecheck-touched）が即時勾配として並走する。

### Phase 3 実装レビュー

office-qa を Task で起動し、機械検証（office-verify / 関連テスト / hooks）を**実際に実行**した上で採点させ、verdict JSON を取得する。

- fail → fix_suggestions を添えて maker に差し戻し Phase 2 へ。自動リトライ 1 回、2 回目 fail で人間へ

### Phase 4 E2E

**現時点（M0）では E2E スイート未整備のため skip とする。skip した事実を PR 本文に必ず記録すること（silent skip 禁止）。M1 で必須化予定。**

（M1 以降: @smoke + 関連 spec を実行。fail → 設計書 §5.3 ループ B の 3 分類で Phase 2 へ）

### Phase 5 反映

1. branch を切り、Conventional Commits でコミット
2. PR を作成し、**本文に Phase 1 / Phase 3 の verdict JSON と Phase 4 の skip 記録を記載**
3. auto-merge を設定（リトライ上限超過で fail のままの場合は draft のまま人間のレビュー待ちとし、auto-merge しない）

## フェーズ別の成果物と fail 時のループ先

| Phase | 内容 | 成果物 | fail 時のループ先 |
|---|---|---|---|
| 0 | 設計 | 変更設計メモ（対象モジュール・受入基準・テスト方針・影響範囲） | — |
| 1 | 設計レビュー | office-qa の verdict JSON | findings を添えて Phase 0（リトライ 1 回、2 回目は人間へ） |
| 2 | 実装（TDD） | red → green のテスト + 実装 diff | — |
| 3 | 実装レビュー | office-qa の verdict JSON | fix_suggestions を添えて Phase 2（リトライ 1 回、2 回目は人間へ） |
| 4 | E2E | （M0: skip 記録のみ / M1: @smoke + 関連 spec の結果） | §5.3 ループ B の 3 分類で Phase 2 |
| 5 | 反映 | PR（verdict JSON + Phase 4 記録を本文に記載）+ auto-merge | — |
