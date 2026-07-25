---
name: masters-format-variance
description: real cc-sier-organization masters/*.md のキー名ゆらぎと部署/ロール数の実測値（2026-07-25、M1-3 時点）
metadata:
  type: project
---

`/home/toyoki05/cc-sier-organization/.companies/` には 3 組織が実在する（実測 2026-07-25）:

| org id | dept 数 | role 数 | 備考 |
|---|---|---|---|
| domain-tech-collection | 3（すべて active） | 3 | `.active` はこの組織 |
| jutaku-dev-team | 6（すべて active） | 13 | |
| standardization-initiative | 2（すべて active） | 2 | |

**standby 部署は実データに 1 件も存在しない**。standby 経路のテストは合成 fixture でしか担保できない（`packages/cc-sier-adapter/src/fixtures/masters.ts` の `DEPARTMENTS_MD_WITH_STANDBY`）。

## roles.md のキー名ゆらぎ（重要・要注意）

同じ「ロール一覧」なのに、組織によって bullet のキー名が違う:

- 所属部署キー: domain-tech-collection は `部署`、jutaku-dev-team / standardization-initiative は `所属部署`
- モデルキー: domain-tech-collection は `モデル`、他 2 組織は `model`
- 表示名キー: domain-tech-collection だけ `名称` を持つ。他 2 組織の roles.md には `名称` が無い（`Subagentファイル` / `所属部署` / `model` / `Agent Teams時の役割` のみ）→ 表示名はロール ID にフォールバックする必要がある
- jutaku-dev-team の一部ロールには「テイメイト指示テンプレート」という複数行のコードフェンス（```）付きキーがあり、フェンス内の行（`スコープ: ...` 等）を誤って未知キーとして拾わないようにパーサ側でフェンス検出が必要

実装は `packages/cc-sier-adapter/src/parse-masters.ts` の `ROLE_DEPT_KEYS` / `ROLE_MODEL_KEYS` / `ROLE_NAME_KEYS`（候補キーの配列で両対応）と、`parseFieldsFromLines` のフェンス検出（`` ``` `` の出現でトグル）で吸収済み。fixture は `fixtures/masters.ts` の `ROLES_MD_ALT_KEYS`。

departments.md 側は 3 組織ともキー名は揃っている（`名称` / `ステータス` / `役割` / `フォルダ` / `対応Subagent` / `トリガーワード`）。ただし `Agent Teams適性` は秘書室（dept-secretary）に付いていたり無かったりする（未知キー扱いで無害）。

## subagent_type（roles.md のロール ID）の組織間衝突

`secretary` は 3 組織すべてに存在し、`project-manager` は jutaku-dev-team と standardization-initiative の両方に存在する。CC-SIer は単一 `.git` の mono-repo に複数組織を同居させ、**`.claude/agents/*.md` は `.companies/.active` が指す組織のものだけが実行時に有効**になる。そのため `attribution.json` の `subagents`（フラットな `Record<subagent_type, {org,dept,role}>`）は組織をまたいで ID が衝突しうる。

解決方針（`packages/cc-sier-adapter/src/attribution-index.ts` に実装済み）: 辞書順で baseline を作った後、`.active` 組織のロールで再上書きする（active org 優先）。これは実行時の `subagent_type` が常に `.active` 組織の定義を指すという実データの前提に基づく判断であり、要件書には明記が無い実装判断。衝突時は warnings に `subagent id "..." is defined in multiple organizations` を出す。

関連: [[adapter_layout_algorithm]]
