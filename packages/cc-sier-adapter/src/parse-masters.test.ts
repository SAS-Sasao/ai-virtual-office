import { describe, expect, it } from "vitest";
import {
  DEPARTMENTS_MD,
  DEPARTMENTS_MD_ALL_BROKEN,
  DEPARTMENTS_MD_MISSING_REQUIRED,
  DEPARTMENTS_MD_MULTI_SUBAGENT,
  DEPARTMENTS_MD_UNKNOWN_KEY,
  DEPARTMENTS_MD_WITH_STANDBY,
  EMPTY_MD,
  ORGANIZATION_MD,
  ROLES_MD,
  ROLES_MD_ALT_KEYS,
  ROLES_MD_MISSING_DEPT,
} from "./fixtures/masters.js";
import {
  parseDepartments,
  parseMasterSections,
  parseOrganization,
  parseRoles,
} from "./parse-masters.js";

describe("parseMasterSections", () => {
  it("splits a departments.md-style document into `## <id>` sections in file order", () => {
    const sections = parseMasterSections(DEPARTMENTS_MD);
    expect(sections.map((s) => s.id)).toEqual(["dept-secretary", "dept-research", "dept-retail-domain"]);
  });

  it("extracts `- **key**: value` bullets into fields", () => {
    const sections = parseMasterSections(DEPARTMENTS_MD);
    const research = sections.find((s) => s.id === "dept-research");
    expect(research?.fields["名称"]).toBe("技術リサーチ室");
    expect(research?.fields["ステータス"]).toBe("active");
  });

  it("parses `[a, b, c]` bracket values into string arrays", () => {
    const sections = parseMasterSections(DEPARTMENTS_MD);
    const research = sections.find((s) => s.id === "dept-research");
    expect(research?.fields["対応Subagent"]).toEqual(["tech-researcher"]);
    expect(research?.fields["トリガーワード"]).toEqual([
      "調査",
      "リサーチ",
      "PoC",
      "検証",
      "トレンド",
      "比較",
      "技術スタック",
    ]);
  });

  it("parses a multi-item bracket array (multiple real Subagents per department)", () => {
    const sections = parseMasterSections(DEPARTMENTS_MD_MULTI_SUBAGENT);
    expect(sections[0].fields["対応Subagent"]).toEqual(["system-architect", "data-architect"]);
  });

  it("parses an empty bracket array `[]` as an empty array, not a 1-item array", () => {
    const sections = parseMasterSections(DEPARTMENTS_MD_UNKNOWN_KEY);
    expect(sections[0].fields["対応Subagent"]).toEqual([]);
    expect(sections[0].fields["トリガーワード"]).toEqual([]);
  });

  it("ignores unknown/undocumented bullet keys instead of erroring", () => {
    const sections = parseMasterSections(DEPARTMENTS_MD_UNKNOWN_KEY);
    expect(sections[0].fields["不明なキー"]).toBe("この値は無視されるべき");
    // 未知キーは「無視」= 呼び出し側の domain パーサ（parseDepartments 等）が
    // 既知キーのみ参照する形で無害化される。parseMasterSections 自体は総称パーサ
    // なので値は保持するが、これは実装の詳細でありドメインパーサの契約には影響しない。
  });

  it("treats a document with no `##` headings as a single section with id ''  (organization.md shape)", () => {
    const sections = parseMasterSections(ORGANIZATION_MD);
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("");
    expect(sections[0].fields["組織名"]).toBe("ドメイン知識や技術スタック収集PJT");
    expect(sections[0].fields["組織ID"]).toBe("domain-tech-collection");
  });

  it("returns an empty section list for a heading-less, bullet-less empty document", () => {
    const sections = parseMasterSections(EMPTY_MD);
    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toEqual({});
  });

  it("does not treat lines inside a code fence as key/value bullets (roles.md teammate template)", () => {
    const sections = parseMasterSections(ROLES_MD_ALT_KEYS);
    const pm = sections.find((s) => s.id === "project-manager");
    // フェンス内の "スコープ: ..." 等の行が誤って未知キーとして拾われていないこと
    expect(pm?.fields["スコープ"]).toBeUndefined();
    expect(pm?.fields["担当プロジェクト"]).toBeUndefined();
    expect(pm?.fields["所属部署"]).toBe("dept-pm");
  });

  it("handles CRLF line endings the same as LF", () => {
    const crlf = DEPARTMENTS_MD.replace(/\n/g, "\r\n");
    const sections = parseMasterSections(crlf);
    expect(sections.map((s) => s.id)).toEqual(["dept-secretary", "dept-research", "dept-retail-domain"]);
    expect(sections[1].fields["名称"]).toBe("技術リサーチ室");
  });
});

describe("parseDepartments", () => {
  it("parses all 3 real departments (all active)", () => {
    const { departments, errors } = parseDepartments(DEPARTMENTS_MD);
    expect(errors).toEqual([]);
    expect(departments).toHaveLength(3);
    expect(departments.map((d) => d.id)).toEqual(["dept-secretary", "dept-research", "dept-retail-domain"]);
    expect(departments.every((d) => d.status === "active")).toBe(true);
  });

  it("captures name/status/triggers/subagents fields", () => {
    const { departments } = parseDepartments(DEPARTMENTS_MD);
    const research = departments.find((d) => d.id === "dept-research");
    expect(research).toMatchObject({
      id: "dept-research",
      name: "技術リサーチ室",
      status: "active",
      subagents: ["tech-researcher"],
    });
    expect(research?.triggers).toContain("調査");
  });

  it("parses a standby department with status: standby", () => {
    const { departments, errors } = parseDepartments(DEPARTMENTS_MD_WITH_STANDBY);
    expect(errors).toEqual([]);
    const standby = departments.find((d) => d.id === "dept-future-lab");
    expect(standby?.status).toBe("standby");
  });

  it("skips a department missing a required field and continues with the rest (partial continuation)", () => {
    const { departments, errors } = parseDepartments(DEPARTMENTS_MD_MISSING_REQUIRED);
    expect(departments.map((d) => d.id)).toEqual(["dept-secretary", "dept-research"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("dept-broken");
  });

  it("returns 0 departments (not a throw) when every section is broken", () => {
    const { departments, errors } = parseDepartments(DEPARTMENTS_MD_ALL_BROKEN);
    expect(departments).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it("returns 0 departments for a heading-less document", () => {
    const { departments, errors } = parseDepartments(EMPTY_MD);
    expect(departments).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("defaults triggers/subagents to [] when the bracket key is entirely absent", () => {
    const md = `## dept-x\n\n- **名称**: X室\n- **ステータス**: active\n`;
    const { departments } = parseDepartments(md);
    expect(departments[0].triggers).toEqual([]);
    expect(departments[0].subagents).toEqual([]);
  });
});

describe("parseRoles", () => {
  it("parses all 3 real roles (名称/部署/モデル key style)", () => {
    const { roles, errors } = parseRoles(ROLES_MD);
    expect(errors).toEqual([]);
    expect(roles).toHaveLength(3);
    expect(roles.map((r) => r.id)).toEqual(["secretary", "tech-researcher", "retail-domain-researcher"]);
  });

  it("captures name/dept/model/description", () => {
    const { roles } = parseRoles(ROLES_MD);
    const researcher = roles.find((r) => r.id === "tech-researcher");
    expect(researcher).toMatchObject({
      id: "tech-researcher",
      name: "テクニカルリサーチャー",
      dept: "dept-research",
      model: "sonnet",
    });
    expect(researcher?.description).toContain("技術調査");
  });

  it("handles the 所属部署/model key variant (jutaku-dev-team shape) identically to 部署/モデル", () => {
    const { roles, errors } = parseRoles(ROLES_MD_ALT_KEYS);
    expect(errors).toEqual([]);
    expect(roles).toHaveLength(2);
    const pm = roles.find((r) => r.id === "project-manager");
    expect(pm?.dept).toBe("dept-pm");
    expect(pm?.model).toBe("sonnet");
  });

  it("falls back to the role id as name when 名称 is absent (jutaku-dev-team roles.md has no 名称 key)", () => {
    const { roles } = parseRoles(ROLES_MD_ALT_KEYS);
    const secretary = roles.find((r) => r.id === "secretary");
    expect(secretary?.name).toBe("secretary");
  });

  it("skips a role missing the required dept field and continues with the rest", () => {
    const { roles, errors } = parseRoles(ROLES_MD_MISSING_DEPT);
    expect(roles.map((r) => r.id)).toEqual(["secretary"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("orphan-role");
  });

  it("returns 0 roles for a heading-less document", () => {
    const { roles, errors } = parseRoles(EMPTY_MD);
    expect(roles).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("parseOrganization", () => {
  it("parses 組織名/組織ID from the real organization.md", () => {
    const { organization, errors } = parseOrganization(ORGANIZATION_MD);
    expect(errors).toEqual([]);
    expect(organization.name).toBe("ドメイン知識や技術スタック収集PJT");
    expect(organization.orgId).toBe("domain-tech-collection");
  });

  it("does not error on a missing 組織名 (caller falls back to the directory id)", () => {
    const { organization, errors } = parseOrganization(EMPTY_MD);
    expect(errors).toEqual([]);
    expect(organization.name).toBeUndefined();
  });
});
