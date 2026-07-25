// parse-masters / import-org / attribution-index の単体テスト用 fixture 群。
//
// 「実マスタのコピー」は /home/toyoki05/cc-sier-organization/.companies/domain-tech-collection/masters/
// を書き写したもの（2026-07-25 実測）。「合成エッジケース」は実データに存在しないパターン
// （standby 部署・必須キー欠落・空配列・未知キー・複数 Subagent・roles.md のキー名ゆらぎ）を
// 補うために作成した。CI 移植性のため、実リポジトリの実在に依存しない（設計メモ「テスト方針」）。

/** 実マスタのコピー: domain-tech-collection/masters/organization.md */
export const ORGANIZATION_MD = `# 組織情報

- **組織名**: ドメイン知識や技術スタック収集PJT
- **組織ID**: domain-tech-collection
- **オーナー名**: 笹尾豊樹
- **事業内容**: SIer
- **セットアップ日**: 2026-03-21
- **COST_AWARENESS**: balanced
`;

/** 実マスタのコピー: domain-tech-collection/masters/departments.md（3 部署、すべて active） */
export const DEPARTMENTS_MD = `# 部署一覧

## dept-secretary

- **名称**: 秘書室
- **ステータス**: active
- **役割**: オーナーの窓口。TODO管理、壁打ち、メモ、作業振り分け
- **フォルダ**: .companies/domain-tech-collection/docs/secretary/
- **対応Subagent**: [secretary]
- **トリガーワード**: [TODO, タスク, 壁打ち, 相談, メモ, ダッシュボード]
- **Agent Teams適性**: low

## dept-research

- **名称**: 技術リサーチ室
- **ステータス**: active
- **役割**: 技術調査、競合分析、PoC、技術スタック評価
- **フォルダ**: .companies/domain-tech-collection/docs/research/
- **対応Subagent**: [tech-researcher]
- **トリガーワード**: [調査, リサーチ, PoC, 検証, トレンド, 比較, 技術スタック]
- **Agent Teams適性**: high

## dept-retail-domain

- **名称**: 小売ドメイン室
- **ステータス**: active
- **役割**: 日本の小売業界のドメイン知識収集・整理。業界用語、業務プロセス、事例の体系化
- **フォルダ**: .companies/domain-tech-collection/docs/retail-domain/
- **対応Subagent**: [retail-domain-researcher]
- **トリガーワード**: [小売, リテール, 流通, 店舗, POS, MD, 棚割, 商品マスタ, 発注, 在庫, EC, オムニチャネル]
- **Agent Teams適性**: medium
`;

/** 実マスタのコピー: domain-tech-collection/masters/roles.md（3 ロール、「名称/部署/モデル」表記） */
export const ROLES_MD = `# ロール一覧

## secretary

- **名称**: 秘書
- **部署**: dept-secretary
- **Subagentファイル**: .claude/agents/secretary.md
- **モデル**: opus
- **説明**: オーナーの常駐窓口。全作業依頼の初回受付、TODO管理、壁打ち、作業振り分けを担当

## tech-researcher

- **名称**: テクニカルリサーチャー
- **部署**: dept-research
- **Subagentファイル**: .claude/agents/tech-researcher.md
- **モデル**: sonnet
- **説明**: 技術調査、競合分析、PoC実施、技術トレンド分析を担当

## retail-domain-researcher

- **名称**: 小売ドメインリサーチャー
- **部署**: dept-retail-domain
- **Subagentファイル**: .claude/agents/retail-domain-researcher.md
- **モデル**: sonnet
- **説明**: 日本の小売業界のドメイン知識収集・整理。業界用語、業務プロセス、事例の体系化を担当
`;

/**
 * 実マスタのコピー: jutaku-dev-team/masters/roles.md の抜粋（「所属部署/model」表記 +
 * 複数行のテイメイト指示テンプレート = コードフェンス）。roles.md のキー名ゆらぎ
 * （部署 vs 所属部署、モデル vs model）と、コードフェンス内の行を誤って
 * キー/値として拾わないことを検証する fixture。
 */
export const ROLES_MD_ALT_KEYS = `# ロール一覧

## secretary

- **Subagentファイル**: .claude/agents/secretary.md
- **所属部署**: dept-secretary
- **model**: opus
- **Agent Teams時の役割**: team-lead

## project-manager

- **Subagentファイル**: .claude/agents/project-manager.md
- **所属部署**: dept-pm
- **model**: sonnet
- **Agent Teams時の役割**: teammate
- **テイメイト指示テンプレート**:
  \`\`\`
  あなたはプロジェクトマネージャーです。
  担当プロジェクト: {project_name}
  スコープ: WBS管理、進捗追跡、リスク識別
  成果物の保存先: .companies/jutaku-dev-team/docs/pm/projects/{project_id}/
  \`\`\`
`;

/** 部署一覧に複数 Subagent（[a, b]）を持つ実データ（jutaku-dev-team）の抜粋。 */
export const DEPARTMENTS_MD_MULTI_SUBAGENT = `# 部署一覧

## dept-architecture

- **名称**: アーキテクチャ室
- **ステータス**: active
- **役割**: システム設計、技術選定、ADR
- **フォルダ**: .companies/jutaku-dev-team/docs/architecture/
- **対応Subagent**: [system-architect, data-architect]
- **トリガーワード**: [設計, アーキテクチャ, 非機能, 技術選定, ADR, 構成図]
- **Agent Teams適性**: high
`;

/**
 * 合成エッジケース: standby 部署を含む departments.md。実データに standby 部署は
 * 存在しない（2026-07-25 実測。一次情報参照）ため、要件 §2.1 の「standby はドア閉鎖・
 * 照明 OFF」のデータを落とさないことを検証する目的で作成。
 */
export const DEPARTMENTS_MD_WITH_STANDBY = `# 部署一覧

## dept-secretary

- **名称**: 秘書室
- **ステータス**: active
- **役割**: オーナーの窓口
- **対応Subagent**: [secretary]
- **トリガーワード**: [TODO]

## dept-research

- **名称**: 技術リサーチ室
- **ステータス**: active
- **役割**: 技術調査
- **対応Subagent**: [tech-researcher]
- **トリガーワード**: [調査]

## dept-future-lab

- **名称**: 未来研究室（休止中）
- **ステータス**: standby
- **役割**: 将来構想の検討（現在は休止）
- **対応Subagent**: []
- **トリガーワード**: []
`;

/**
 * 合成エッジケース: 1 部署が必須キー（ステータス）を欠落。パースは部分継続し、
 * 他の 2 部署は正常に処理されることを検証する（parse-masters「1 部署の破損で
 * 全体を失敗させない」の対象ケース）。
 */
export const DEPARTMENTS_MD_MISSING_REQUIRED = `# 部署一覧

## dept-secretary

- **名称**: 秘書室
- **ステータス**: active
- **対応Subagent**: [secretary]
- **トリガーワード**: [TODO]

## dept-broken

- **役割**: ステータスも名称も無い壊れたセクション
- **対応Subagent**: [ghost]

## dept-research

- **名称**: 技術リサーチ室
- **ステータス**: active
- **対応Subagent**: [tech-researcher]
- **トリガーワード**: [調査]
`;

/** 合成エッジケース: 見出しはあるが有効なセクションが 1 つも無い（0 件 = 全体失敗トリガー用）。 */
export const DEPARTMENTS_MD_ALL_BROKEN = `# 部署一覧

## dept-broken-1

- **役割**: 名称もステータスも無い

## dept-broken-2

- **フォルダ**: .companies/x/docs/broken/
`;

/** 合成エッジケース: 見出しすら無い空文書。 */
export const EMPTY_MD = `\n\n`;

/**
 * 合成エッジケース: 未知キー混入（ロールの説明に無いフィールドを追加）+
 * 空配列 `[]`。未知キーは無視され、既知キーのみ抽出されることを検証する。
 */
export const DEPARTMENTS_MD_UNKNOWN_KEY = `# 部署一覧

## dept-empty-triggers

- **名称**: トリガー無し部署
- **ステータス**: active
- **不明なキー**: この値は無視されるべき
- **対応Subagent**: []
- **トリガーワード**: []
`;

/** 合成エッジケース: ロールが必須の部署キーを欠落。 */
export const ROLES_MD_MISSING_DEPT = `# ロール一覧

## orphan-role

- **名称**: 所属先の無いロール
- **Subagentファイル**: .claude/agents/orphan-role.md
- **モデル**: sonnet

## secretary

- **名称**: 秘書
- **部署**: dept-secretary
- **モデル**: opus
`;
