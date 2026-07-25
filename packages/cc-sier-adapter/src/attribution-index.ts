// 帰属インデックス（attribution.json）の生成。fs には一切触れない純関数。
//
// relay/src/attribute.ts（pipeline-dev 担当）はこの JSON を読むだけで CC-SIer を
// 一切知らない（プログレッシブ・ディスクロージャ。アーキ設計 §5・§10.2）。
//
// repoPrefixes は「リポジトリ内のどのパスも `.companies/.active` の組織に帰属する」
// という規則（FR-4 規則 1 / 要件 §5.3「.companies/.active から組織を特定」）に従い、
// リポジトリごとに .active 組織を指す 1 エントリだけを積む（cc-sier は単一 .git の
// mono-repo に複数組織を同居させているため、ディレクトリごとに異なる org を割り当てる
// ことはしない。一次情報・ADR-003 参照）。
//
// subagents は roles.md 由来の全ロールを対象にするが、実データでは同じロール ID
// （例: "secretary"）が複数組織に存在しうる（cc-sier は .active 組織の
// `.claude/agents/*.md` だけが実行時に有効になるため）。この衝突は
// 「.active 組織のロール定義を優先する」規則で解決する（実行時に Claude Code が
// 報告する subagent_type は常に .active 組織のものであるという実データの前提に基づく）。
import type { AttributionIndex } from "@ai-office/protocol";
import { compareCodePoint } from "./sort-util.js";

export interface AttributionRoleInput {
  id: string;
  dept: string;
}

export interface AttributionOrgInput {
  orgId: string;
  /** departments.md に存在する部署 ID の一覧（active/standby 問わず）。receptionDept の判定に使う。 */
  deptIds: string[];
  roles: AttributionRoleInput[];
}

export interface AttributionRepoInput {
  repoRoot: string;
  /** `.companies/.active` の内容。ファイルが無い/読めない場合は undefined。 */
  activeOrgId?: string;
  orgs: AttributionOrgInput[];
}

export interface BuildAttributionIndexInput {
  repos: AttributionRepoInput[];
}

export interface BuildAttributionIndexResult {
  index: AttributionIndex;
  warnings: string[];
}

const RECEPTION_DEPT_ID = "dept-secretary";

export function buildAttributionIndex(input: BuildAttributionIndexInput): BuildAttributionIndexResult {
  const warnings: string[] = [];
  const repoPrefixes: AttributionIndex["repoPrefixes"] = [];
  const branchOrgSet = new Set<string>();
  const receptionDept: AttributionIndex["receptionDept"] = {};
  const subagents: AttributionIndex["subagents"] = {};

  for (const repo of input.repos) {
    // codepoint 順（既定 Array.prototype.sort() と同じ規則）で並べる。localeCompare は
    // 実行環境のロケールに依存し discoverOrgs/branchOrgs の既定 sort と食い違うため使わない
    // （[[compareCodePoint]] 参照。Phase 3 レビュー指摘 2 の修正）。
    const sortedOrgs = [...repo.orgs].sort((a, b) => compareCodePoint(a.orgId, b.orgId));

    if (repo.activeOrgId !== undefined) {
      const activeKnown = sortedOrgs.some((o) => o.orgId === repo.activeOrgId);
      if (activeKnown) {
        repoPrefixes.push({ prefix: repo.repoRoot, org: repo.activeOrgId });
      } else {
        warnings.push(
          `repo "${repo.repoRoot}": .active org "${repo.activeOrgId}" does not match any discovered organization (repoPrefix omitted)`,
        );
      }
    }

    for (const org of sortedOrgs) {
      branchOrgSet.add(org.orgId);
      if (org.deptIds.includes(RECEPTION_DEPT_ID)) {
        receptionDept[org.orgId] = RECEPTION_DEPT_ID;
      }

      // baseline: 辞書順で後の org が先の org を上書きする（決定論のためだけの順序で、
      // 優先順位の意図は無い）。衝突があれば警告する。
      for (const role of org.roles) {
        const prior = subagents[role.id];
        if (prior && prior.org !== org.orgId) {
          warnings.push(
            `subagent id "${role.id}" is defined in multiple organizations (${prior.org}, ${org.orgId}); resolving to the .active organization when available`,
          );
        }
        subagents[role.id] = { org: org.orgId, dept: role.dept, role: role.id };
      }
    }

    // active org のロールを最後に再適用し、衝突時は必ず .active 組織を勝たせる
    // （実行時の subagent_type は常に .active 組織の定義を指すため）。
    if (repo.activeOrgId !== undefined) {
      const activeOrg = sortedOrgs.find((o) => o.orgId === repo.activeOrgId);
      if (activeOrg) {
        for (const role of activeOrg.roles) {
          subagents[role.id] = { org: activeOrg.orgId, dept: role.dept, role: role.id };
        }
      }
    }
  }

  // 既定 Array.prototype.sort()（codepoint 順）。sortedOrgs と同じ規則に統一する。
  const branchOrgs = [...branchOrgSet].sort(compareCodePoint);

  const index: AttributionIndex = {
    version: 1,
    repoPrefixes,
    branchOrgs,
    subagents,
    receptionDept,
  };

  return { index, warnings };
}
