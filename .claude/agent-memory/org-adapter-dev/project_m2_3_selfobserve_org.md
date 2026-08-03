---
name: project-m2-3-selfobserve-org
description: M2-3 で ai-virtual-office 自身を .companies/ 方式で観測 org 化した実装内容と検証手順（2026-08-03）
metadata:
  type: project
---

ai-virtual-office リポジトリ自身を CC-SIer 形式の `.companies/ai-virtual-office/masters/` で org 化し、既存 cc-sier アダプタ（コード無変更）で 4 org 目としてインポートした（M2-3、ブランチ `feat/2026-08-03-m2-selfobserve`、設計は Phase 1 rev.2 composite 0.92 で pass 済み）。

## 実装した構成
- `.companies/ai-virtual-office/masters/departments.md`（6 部署・全 active）と `roles.md`（5 ロール = 本 repo の実サブエージェント名: game-engine-dev/pipeline-dev/ui-dev/org-adapter-dev/office-qa）を新規作成、コミット対象
- `.companies/.active` に `ai-virtual-office`（**必須**。無いと `attribution-index.ts` の `repoPrefixes.push` が `activeOrgId !== undefined` ゲートで発火せず、規則1 の cwd→org 帰属が不発になる）
- `secretary` ロールは意図的に置いていない（cc-sier 側の `secretary` role id と衝突し attribution の重複警告を招くため）。dept-secretary は受付部屋（住人ロール無し）としてのみ存在
- `~/.ai-office/config.json`（repo 外・非コミット）の `organizations[]` に `{repo: /home/toyoki05/ai-virtual-office, type: cc-sier}` を追記（cc-sier-organization と併存、2 org 化）

## 再インポートの正しい手順（実測で確認済み）
`node packages/cc-sier-adapter/dist/cli.js import --out ~/.ai-office/layouts`（**`--repo` を付けない**）。理由: `--repo` はリピート指定しても `parseArgs` が単一値として上書きするため `--repo A --repo B` は最後の1個しか採用されず他 repo をドロップする。`--repo` 省略時のみ config.json の `organizations[]` 全件を読む。実行前に `~/.ai-office/layouts` と `config.json` をバックアップ（`*.bak-2026-08-03`）してからこの経路で再生成した。

## 検証済みの結果（実測）
- 4 floor / 23 characters（既存18 + 新規5）に増加。既存3 org（domain-tech-collection/jutaku-dev-team/standardization-initiative）の room/character 内容は diff で byte-identical（配列順のみ codepoint sort で ai-virtual-office が先頭化してシフト、ドロップ・改変なし）
- stderr warnings は cc-sier 由来の secretary/project-manager 重複のみ（既知・[[masters_format_variance]] 記載の subagent_type 衝突）。ai-virtual-office 関連の parse エラー・重複警告は 0 件
- `attribution.json` に repoPrefix `{prefix: /home/toyoki05/ai-virtual-office, org: ai-virtual-office}` が生成され、5 サブエージェント全てが org/dept/role にマップ

## 気づき: verify.sh 内の `pnpm -r run build` はドッグフーディング dev server を壊さない
「素の `pnpm -r build` 禁止（dogfooding :3001 の .next 破壊）」という制約は cc-sier-adapter 単体を再ビルドする目的で自分から `pnpm -r build` を叩くケースへの戒め。一方 `.claude/skills/office-verify/scripts/verify.sh` は内部で `pnpm -r run build`（`apps/web` の `next build` 含む）を実行するが、これは AC-7 の正規手順として意図的に許容されている。実測（2026-08-03）: verify.sh 実行後も `:3001`/`:4100` の既存プロセス（起動時刻不変）は生存し `/api/layout` は 200 のまま。`next dev` と `next build` の `.next` 事故は常に起きるわけではない（このケースでは無害だった）ため、混同して verify.sh の実行自体を避けないこと。ただし本質的なリスクがゼロと確定したわけではなく、今後同様の事故報告があれば再検証すること。

関連: [[masters_format_variance]] [[adapter_layout_algorithm]]
