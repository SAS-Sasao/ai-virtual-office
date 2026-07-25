import { describe, expect, it } from "vitest";
import { createFakeFs } from "./testing/fake-fs.js";
import {
  discoverOrgs,
  parseArgs,
  readOrgMasters,
  resolveOutDir,
  resolveRepos,
  runCli,
  runImport,
  type CliDeps,
} from "./cli.js";
import { DEPARTMENTS_MD, DEPARTMENTS_MD_ALL_BROKEN, ORGANIZATION_MD, ROLES_MD } from "./fixtures/masters.js";

function makeDeps(files: Record<string, string> = {}, overrides: Partial<CliDeps> = {}): CliDeps & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const fs = createFakeFs(files);
  return {
    fs,
    homedir: () => "/home/fake-user",
    env: {},
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    logs,
    errors,
    ...overrides,
  };
}

function realOrgFiles(repoRoot: string, orgId = "domain-tech-collection"): Record<string, string> {
  return {
    [`${repoRoot}/.companies/.active`]: `${orgId}\n`,
    [`${repoRoot}/.companies/${orgId}/masters/organization.md`]: ORGANIZATION_MD,
    [`${repoRoot}/.companies/${orgId}/masters/departments.md`]: DEPARTMENTS_MD,
    [`${repoRoot}/.companies/${orgId}/masters/roles.md`]: ROLES_MD,
  };
}

describe("parseArgs", () => {
  it("parses the import command with --repo/--out/--dry-run", () => {
    const { command, flags } = parseArgs(["import", "--repo", "/r", "--out", "/o", "--dry-run"]);
    expect(command).toBe("import");
    expect(flags).toMatchObject({ repo: "/r", out: "/o", dryRun: true, help: false });
  });

  it("defaults repo/out to undefined and dryRun/help to false when omitted", () => {
    const { command, flags } = parseArgs(["import"]);
    expect(command).toBe("import");
    expect(flags).toEqual({ repo: undefined, out: undefined, dryRun: false, help: false });
  });

  it("recognizes --help / -h", () => {
    expect(parseArgs(["--help"]).flags.help).toBe(true);
    expect(parseArgs(["-h"]).flags.help).toBe(true);
  });
});

describe("resolveRepos", () => {
  it("uses --repo directly when given, without touching config.json", () => {
    const deps = makeDeps();
    const result = resolveRepos({ repo: "/explicit/repo", out: undefined, dryRun: false, help: false }, deps);
    expect(result).toEqual({ repos: ["/explicit/repo"] });
  });

  it("falls back to ~/.ai-office/config.json organizations[] (type: cc-sier) when --repo is omitted", () => {
    const deps = makeDeps({
      "/home/fake-user/.ai-office/config.json": JSON.stringify({
        organizations: [{ repo: "/cc-sier-org", type: "cc-sier" }],
      }),
    });
    const result = resolveRepos({ repo: undefined, out: undefined, dryRun: false, help: false }, deps);
    expect(result).toEqual({ repos: ["/cc-sier-org"] });
  });

  it("filters out non-cc-sier organizations[] entries", () => {
    const deps = makeDeps({
      "/home/fake-user/.ai-office/config.json": JSON.stringify({
        organizations: [
          { repo: "/other", type: "some-other-format" },
          { repo: "/cc-sier-org", type: "cc-sier" },
        ],
      }),
    });
    const result = resolveRepos({ repo: undefined, out: undefined, dryRun: false, help: false }, deps);
    expect(result).toEqual({ repos: ["/cc-sier-org"] });
  });

  it("returns an error (not a throw) when config.json is missing", () => {
    const deps = makeDeps();
    const result = resolveRepos({ repo: undefined, out: undefined, dryRun: false, help: false }, deps);
    expect("error" in result).toBe(true);
  });

  it("returns an error when config.json is invalid JSON", () => {
    const deps = makeDeps({ "/home/fake-user/.ai-office/config.json": "{ not json" });
    const result = resolveRepos({ repo: undefined, out: undefined, dryRun: false, help: false }, deps);
    expect("error" in result).toBe(true);
  });

  it("returns an error when organizations[] has no cc-sier entries", () => {
    const deps = makeDeps({
      "/home/fake-user/.ai-office/config.json": JSON.stringify({ organizations: [] }),
    });
    const result = resolveRepos({ repo: undefined, out: undefined, dryRun: false, help: false }, deps);
    expect("error" in result).toBe(true);
  });
});

describe("resolveOutDir", () => {
  it("prefers --out over everything else", () => {
    const deps = makeDeps({}, { env: { AI_OFFICE_LAYOUTS_DIR: "/env-dir" } });
    const dir = resolveOutDir({ repo: undefined, out: "/flag-dir", dryRun: false, help: false }, deps);
    expect(dir).toBe("/flag-dir");
  });

  it("falls back to AI_OFFICE_LAYOUTS_DIR when --out is absent", () => {
    const deps = makeDeps({}, { env: { AI_OFFICE_LAYOUTS_DIR: "/env-dir" } });
    const dir = resolveOutDir({ repo: undefined, out: undefined, dryRun: false, help: false }, deps);
    expect(dir).toBe("/env-dir");
  });

  it("falls back to ~/.ai-office/layouts as the last resort", () => {
    const deps = makeDeps();
    const dir = resolveOutDir({ repo: undefined, out: undefined, dryRun: false, help: false }, deps);
    expect(dir).toBe("/home/fake-user/.ai-office/layouts");
  });
});

describe("discoverOrgs / readOrgMasters", () => {
  it("lists organization directories under .companies/ in sorted order, and reads .active", () => {
    const deps = makeDeps({
      "/repo/.companies/.active": "domain-tech-collection\n",
      "/repo/.companies/zzz-org/masters/departments.md": "x",
      "/repo/.companies/domain-tech-collection/masters/departments.md": "x",
    });
    const { orgIds, activeOrgId } = discoverOrgs("/repo", deps.fs);
    expect(orgIds).toEqual(["domain-tech-collection", "zzz-org"]);
    expect(activeOrgId).toBe("domain-tech-collection");
  });

  it("returns activeOrgId: undefined when .active is missing", () => {
    const deps = makeDeps({ "/repo/.companies/some-org/masters/departments.md": "x" });
    const { activeOrgId } = discoverOrgs("/repo", deps.fs);
    expect(activeOrgId).toBeUndefined();
  });

  it("returns an empty orgIds list (not a throw) when .companies/ does not exist", () => {
    const deps = makeDeps();
    const { orgIds } = discoverOrgs("/repo-without-companies", deps.fs);
    expect(orgIds).toEqual([]);
  });

  it("reads the 3 masters files for an org, leaving missing files as undefined", () => {
    const deps = makeDeps({
      "/repo/.companies/org-1/masters/organization.md": "org md",
      "/repo/.companies/org-1/masters/departments.md": "dept md",
      // roles.md 欠落
    });
    const masters = readOrgMasters("/repo", "org-1", deps.fs);
    expect(masters).toEqual({
      orgId: "org-1",
      organizationMd: "org md",
      departmentsMd: "dept md",
      rolesMd: undefined,
    });
  });
});

describe("runImport", () => {
  it("writes office-layout.json / characters.json / attribution.json for a valid real-shaped repo (AC-2 shape)", () => {
    const deps = makeDeps(realOrgFiles("/repo"));
    const result = runImport({ repo: "/repo", out: "/out", dryRun: false, help: false }, deps);

    expect(result.exitCode).toBe(0);
    const layout = JSON.parse(deps.fs.files.get("/out/office-layout.json")!);
    const characters = JSON.parse(deps.fs.files.get("/out/characters.json")!);
    const attribution = JSON.parse(deps.fs.files.get("/out/attribution.json")!);

    expect(layout.floors).toHaveLength(1);
    expect(layout.floors[0].org).toBe("domain-tech-collection");
    expect(layout.floors[0].rooms.filter((r: { status: string }) => r.status === "active")).toHaveLength(3);
    expect(characters).toHaveLength(3);
    expect(attribution.repoPrefixes).toEqual([{ prefix: "/repo", org: "domain-tech-collection" }]);
  });

  it("dry-run does not write any file", () => {
    const deps = makeDeps(realOrgFiles("/repo"));
    const result = runImport({ repo: "/repo", out: "/out", dryRun: true, help: false }, deps);
    expect(result.exitCode).toBe(0);
    expect(deps.fs.files.has("/out/office-layout.json")).toBe(false);
  });

  it("AC-4: preserves a custom: true room across a re-import, while regenerating the rest", () => {
    const deps = makeDeps(realOrgFiles("/repo"));
    const first = runImport({ repo: "/repo", out: "/out", dryRun: false, help: false }, deps);
    expect(first.exitCode).toBe(0);

    const layout = JSON.parse(deps.fs.files.get("/out/office-layout.json")!);
    layout.floors[0].rooms.push({
      id: "lounge",
      name: "談話室（手動追加）",
      status: "active",
      x: 0,
      y: 30,
      w: 6,
      h: 4,
      triggers: [],
      custom: true,
    });
    deps.fs.files.set("/out/office-layout.json", JSON.stringify(layout, null, 2));

    const second = runImport({ repo: "/repo", out: "/out", dryRun: false, help: false }, deps);
    expect(second.exitCode).toBe(0);
    const reImported = JSON.parse(deps.fs.files.get("/out/office-layout.json")!);
    const roomIds = reImported.floors[0].rooms.map((r: { id: string }) => r.id);
    expect(roomIds).toContain("lounge");
    expect(roomIds).toContain("dept-research"); // 生成分も引き続き存在する
  });

  it("AC-5: on total parse failure (0 departments), existing output files are left byte-for-byte untouched and exit code is non-zero", () => {
    const existingLayout = JSON.stringify({ version: 1, floors: [] }, null, 2);
    const existingCharacters = JSON.stringify([], null, 2);
    const deps = makeDeps({
      "/repo/.companies/.active": "broken-org\n",
      "/repo/.companies/broken-org/masters/departments.md": DEPARTMENTS_MD_ALL_BROKEN,
      "/out/office-layout.json": existingLayout,
      "/out/characters.json": existingCharacters,
    });

    const result = runImport({ repo: "/repo", out: "/out", dryRun: false, help: false }, deps);

    expect(result.exitCode).not.toBe(0);
    expect(deps.fs.files.get("/out/office-layout.json")).toBe(existingLayout);
    expect(deps.fs.files.get("/out/characters.json")).toBe(existingCharacters);
    expect(deps.fs.files.has("/out/attribution.json")).toBe(false);
    expect(deps.errors.some((e) => e.includes("import failed"))).toBe(true);
  });

  it("AC-5: an unresolvable --repo / config error also leaves existing output untouched", () => {
    const existingLayout = JSON.stringify({ version: 1, floors: [] }, null, 2);
    const deps = makeDeps({ "/out/office-layout.json": existingLayout });
    const result = runImport({ repo: undefined, out: "/out", dryRun: false, help: false }, deps);
    expect(result.exitCode).not.toBe(0);
    expect(deps.fs.files.get("/out/office-layout.json")).toBe(existingLayout);
  });

  it("AC-3: two successive runs against unchanged input produce byte-identical output files", () => {
    const deps = makeDeps(realOrgFiles("/repo"));
    runImport({ repo: "/repo", out: "/out", dryRun: false, help: false }, deps);
    const firstLayout = deps.fs.files.get("/out/office-layout.json");
    const firstCharacters = deps.fs.files.get("/out/characters.json");
    const firstAttribution = deps.fs.files.get("/out/attribution.json");

    runImport({ repo: "/repo", out: "/out", dryRun: false, help: false }, deps);
    expect(deps.fs.files.get("/out/office-layout.json")).toBe(firstLayout);
    expect(deps.fs.files.get("/out/characters.json")).toBe(firstCharacters);
    expect(deps.fs.files.get("/out/attribution.json")).toBe(firstAttribution);
  });

  it("never reads or writes anything under the fake home directory's .ai-office when --repo/--out are both explicit", () => {
    const deps = makeDeps(realOrgFiles("/repo"));
    runImport({ repo: "/repo", out: "/out", dryRun: false, help: false }, deps);
    for (const path of deps.fs.files.keys()) {
      expect(path.startsWith("/home/fake-user/.ai-office")).toBe(false);
    }
  });
});

describe("runCli", () => {
  it("prints help and exits 0 when no command is given", () => {
    const deps = makeDeps();
    const code = runCli([], deps);
    expect(code).toBe(0);
    expect(deps.logs.join("\n")).toContain("ai-office-adapter");
  });

  it("returns a non-zero exit code for an unknown command", () => {
    const deps = makeDeps();
    const code = runCli(["bogus"], deps);
    expect(code).not.toBe(0);
    expect(deps.errors.some((e) => e.includes("bogus"))).toBe(true);
  });

  it("dispatches 'import' to runImport", () => {
    const deps = makeDeps(realOrgFiles("/repo"));
    const code = runCli(["import", "--repo", "/repo", "--out", "/out"], deps);
    expect(code).toBe(0);
    expect(deps.fs.files.has("/out/office-layout.json")).toBe(true);
  });
});
