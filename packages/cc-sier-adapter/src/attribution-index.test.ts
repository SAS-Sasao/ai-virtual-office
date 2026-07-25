import { describe, expect, it } from "vitest";
import { buildAttributionIndex, type BuildAttributionIndexInput } from "./attribution-index.js";

const singleOrgInput: BuildAttributionIndexInput = {
  repos: [
    {
      repoRoot: "/home/toyoki05/cc-sier-organization",
      activeOrgId: "domain-tech-collection",
      orgs: [
        {
          orgId: "domain-tech-collection",
          deptIds: ["dept-secretary", "dept-research", "dept-retail-domain"],
          roles: [
            { id: "secretary", dept: "dept-secretary" },
            { id: "tech-researcher", dept: "dept-research" },
            { id: "retail-domain-researcher", dept: "dept-retail-domain" },
          ],
        },
      ],
    },
  ],
};

describe("buildAttributionIndex", () => {
  it("builds version:1 and a repoPrefix pointing at the .active org (FR-4 rule 1)", () => {
    const { index } = buildAttributionIndex(singleOrgInput);
    expect(index.version).toBe(1);
    expect(index.repoPrefixes).toEqual([
      { prefix: "/home/toyoki05/cc-sier-organization", org: "domain-tech-collection" },
    ]);
  });

  it("collects every org id into branchOrgs, sorted for determinism (FR-4 rule 2, dormant per ADR-003)", () => {
    const { index } = buildAttributionIndex({
      repos: [
        {
          repoRoot: "/r",
          activeOrgId: "b-org",
          orgs: [
            { orgId: "b-org", deptIds: [], roles: [] },
            { orgId: "a-org", deptIds: [], roles: [] },
          ],
        },
      ],
    });
    expect(index.branchOrgs).toEqual(["a-org", "b-org"]);
  });

  it("maps every role from roles.md into subagents, keyed by role id (FR-4 rule 3)", () => {
    const { index } = buildAttributionIndex(singleOrgInput);
    expect(index.subagents).toEqual({
      secretary: { org: "domain-tech-collection", dept: "dept-secretary", role: "secretary" },
      "tech-researcher": { org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" },
      "retail-domain-researcher": {
        org: "domain-tech-collection",
        dept: "dept-retail-domain",
        role: "retail-domain-researcher",
      },
    });
  });

  it("sets receptionDept to dept-secretary for every org that actually declares it", () => {
    const { index } = buildAttributionIndex(singleOrgInput);
    expect(index.receptionDept).toEqual({ "domain-tech-collection": "dept-secretary" });
  });

  it("omits receptionDept for an org without a dept-secretary department (graceful, no guessing)", () => {
    const { index } = buildAttributionIndex({
      repos: [
        {
          repoRoot: "/r",
          activeOrgId: "no-reception-org",
          orgs: [{ orgId: "no-reception-org", deptIds: ["dept-research"], roles: [] }],
        },
      ],
    });
    expect(index.receptionDept).toEqual({});
  });

  it("omits the repoPrefix entry when .active does not resolve to a known org", () => {
    const { index } = buildAttributionIndex({
      repos: [
        {
          repoRoot: "/r",
          activeOrgId: "ghost-org",
          orgs: [{ orgId: "real-org", deptIds: [], roles: [] }],
        },
      ],
    });
    expect(index.repoPrefixes).toEqual([]);
  });

  it("omits the repoPrefix entry when activeOrgId is undefined (.active missing/unreadable)", () => {
    const { index } = buildAttributionIndex({
      repos: [{ repoRoot: "/r", orgs: [{ orgId: "real-org", deptIds: [], roles: [] }] }],
    });
    expect(index.repoPrefixes).toEqual([]);
  });

  it("resolves a subagent id collision across orgs in favor of the active org, and warns", () => {
    // activeOrgId は org-a（辞書順で org-b より前）。org-b 側だけを「後勝ち」に
    // していないことを確認するため、あえて辞書順の baseline とは逆の org を active にする。
    const { index, warnings } = buildAttributionIndex({
      repos: [
        {
          repoRoot: "/r",
          activeOrgId: "org-a",
          orgs: [
            { orgId: "org-a", deptIds: ["dept-secretary"], roles: [{ id: "secretary", dept: "dept-secretary" }] },
            { orgId: "org-b", deptIds: ["dept-secretary"], roles: [{ id: "secretary", dept: "dept-secretary" }] },
          ],
        },
      ],
    });
    expect(index.subagents.secretary.org).toBe("org-a");
    expect(warnings.some((w) => w.includes("secretary"))).toBe(true);
  });

  it("is deterministic regardless of input org array order (no reliance on fs readdir order)", () => {
    const inOrder = buildAttributionIndex({
      repos: [
        {
          repoRoot: "/r",
          activeOrgId: "b-org",
          orgs: [
            { orgId: "a-org", deptIds: [], roles: [{ id: "role-a", dept: "dept-a" }] },
            { orgId: "b-org", deptIds: [], roles: [{ id: "role-b", dept: "dept-b" }] },
          ],
        },
      ],
    });
    const reversed = buildAttributionIndex({
      repos: [
        {
          repoRoot: "/r",
          activeOrgId: "b-org",
          orgs: [
            { orgId: "b-org", deptIds: [], roles: [{ id: "role-b", dept: "dept-b" }] },
            { orgId: "a-org", deptIds: [], roles: [{ id: "role-a", dept: "dept-a" }] },
          ],
        },
      ],
    });
    expect(JSON.stringify(inOrder.index)).toBe(JSON.stringify(reversed.index));
  });

  // Phase 3 レビュー指摘 2（low）: sortedOrgs の並び替えは localeCompare ではなく
  // 既定 Array.prototype.sort()（codepoint 順）と同じ規則で行う（discoverOrgs /
  // branchOrgs との整合。決定論性のため実行環境のロケールに依存してはいけない）。
  it("resolves a baseline (no active org) collision using codepoint sort order, not locale order", () => {
    const ids = ["a_z", "a-z", "B-y"];
    // 事前条件の確認: この 3 つの id は localeCompare と codepoint 順で実際に食い違う
    expect([...ids].sort((a, b) => a.localeCompare(b))).not.toEqual([...ids].sort());

    const { index } = buildAttributionIndex({
      repos: [
        {
          repoRoot: "/r",
          // activeOrgId 未指定 = active org による上書きが起きない。baseline の
          // 「辞書順で後の org が勝つ」だけで衝突が解決されるケースを狙う。
          orgs: ids.map((orgId) => ({ orgId, deptIds: [], roles: [{ id: "shared", dept: "dept-x" }] })),
        },
      ],
    });

    // codepoint 順で最後に処理される org（= [...ids].sort() の最後の要素）が勝つ
    const codepointOrder = [...ids].sort();
    expect(index.subagents.shared.org).toBe(codepointOrder[codepointOrder.length - 1]);
  });

  it("aggregates across multiple repos (multiple config.json organizations[] entries)", () => {
    const { index } = buildAttributionIndex({
      repos: [
        {
          repoRoot: "/repo-1",
          activeOrgId: "org-1",
          orgs: [{ orgId: "org-1", deptIds: ["dept-secretary"], roles: [{ id: "secretary", dept: "dept-secretary" }] }],
        },
        {
          repoRoot: "/repo-2",
          activeOrgId: "org-2",
          orgs: [{ orgId: "org-2", deptIds: ["dept-secretary"], roles: [{ id: "pm", dept: "dept-pm" }] }],
        },
      ],
    });
    expect(index.repoPrefixes).toEqual([
      { prefix: "/repo-1", org: "org-1" },
      { prefix: "/repo-2", org: "org-2" },
    ]);
    expect(Object.keys(index.subagents).sort()).toEqual(["pm", "secretary"]);
  });

  it("returns an empty (but valid) index for zero repos", () => {
    const { index, warnings } = buildAttributionIndex({ repos: [] });
    expect(index).toEqual({ version: 1, repoPrefixes: [], branchOrgs: [], subagents: {}, receptionDept: {} });
    expect(warnings).toEqual([]);
  });
});
