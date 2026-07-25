import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AttributionIndex } from "@ai-office/protocol";
import { createAttributor, loadAttributor, resolveAttributionPath } from "./attribute.js";

function makeIndex(overrides: Partial<AttributionIndex> = {}): AttributionIndex {
  return {
    version: 1,
    repoPrefixes: [],
    branchOrgs: [],
    subagents: {},
    receptionDept: {},
    ...overrides,
  };
}

describe("createAttributor — rule 1 (cwd prefix match)", () => {
  it("attributes org when cwd exactly equals a repoPrefixes entry", () => {
    const index = makeIndex({
      repoPrefixes: [{ prefix: "/home/user/cc-sier-organization", org: "domain-tech-collection" }],
    });
    const attribute = createAttributor({ index });

    const result = attribute({ cwd: "/home/user/cc-sier-organization" });

    expect(result).toEqual({ org: "domain-tech-collection" });
  });

  it("attributes org when cwd is a subdirectory of a repoPrefixes entry", () => {
    const index = makeIndex({
      repoPrefixes: [{ prefix: "/home/user/cc-sier-organization", org: "domain-tech-collection" }],
    });
    const attribute = createAttributor({ index });

    const result = attribute({
      cwd: "/home/user/cc-sier-organization/.companies/domain-tech-collection",
    });

    expect(result).toEqual({ org: "domain-tech-collection" });
  });

  it("does not false-positive-match a sibling directory that merely shares the prefix string", () => {
    const index = makeIndex({
      repoPrefixes: [{ prefix: "/home/user/cc-sier-organization", org: "domain-tech-collection" }],
    });
    const attribute = createAttributor({ index });

    // "/home/user/cc-sier-organization-other" starts with the prefix string but is not
    // a subdirectory of it — must not match (boundary must respect '/' separators).
    const result = attribute({ cwd: "/home/user/cc-sier-organization-other" });

    expect(result).toEqual({});
  });

  it("returns no fields when cwd is missing or not a string", () => {
    const index = makeIndex({
      repoPrefixes: [{ prefix: "/home/user/cc-sier-organization", org: "domain-tech-collection" }],
    });
    const attribute = createAttributor({ index });

    expect(attribute({})).toEqual({});
    expect(attribute({ cwd: 42 })).toEqual({});
  });
});

describe("createAttributor — rule 2 (branch prefix match via injected readBranch)", () => {
  it("attributes org from a branch name with a matching {org}/... prefix (fixture readBranch)", () => {
    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({
      index,
      readBranch: () => "domain-tech-collection/feature-x",
    });

    const result = attribute({ cwd: "/some/repo" });

    expect(result).toEqual({ org: "domain-tech-collection" });
  });

  it("only consults readBranch when rule 1 did not already determine org", () => {
    const index = makeIndex({
      repoPrefixes: [{ prefix: "/some/repo", org: "org-from-rule-1" }],
      branchOrgs: ["org-from-rule-2"],
    });
    let readBranchCalls = 0;
    const attribute = createAttributor({
      index,
      readBranch: () => {
        readBranchCalls += 1;
        return "org-from-rule-2/feature";
      },
    });

    const result = attribute({ cwd: "/some/repo" });

    expect(result).toEqual({ org: "org-from-rule-1" });
    expect(readBranchCalls).toBe(0);
  });

  it("returns no fields when the branch name has no matching {org}/ prefix (e.g. a plain 'main')", () => {
    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({ index, readBranch: () => "main" });

    const result = attribute({ cwd: "/some/repo" });

    expect(result).toEqual({});
  });

  it("returns no fields when readBranch returns undefined", () => {
    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({ index, readBranch: () => undefined });

    const result = attribute({ cwd: "/some/repo" });

    expect(result).toEqual({});
  });

  it("swallows exceptions thrown by a custom readBranch and falls back to no attribution", () => {
    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({
      index,
      readBranch: () => {
        throw new Error("boom");
      },
    });

    expect(() => attribute({ cwd: "/some/repo" })).not.toThrow();
    expect(attribute({ cwd: "/some/repo" })).toEqual({});
  });
});

describe("createAttributor — rule 2 default readBranch (real .git/HEAD on disk)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-office-relay-attribute-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("attributes org from a real .git/HEAD whose branch has a matching {org}/ prefix", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/domain-tech-collection/feature-x\n");

    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({ index });

    const result = attribute({ cwd: dir });

    expect(result).toEqual({ org: "domain-tech-collection" });
  });

  it("falls back to no attribution for a real-world HEAD shape ('ref: refs/heads/main')", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({ index });

    const result = attribute({ cwd: dir });

    expect(result).toEqual({});
  });

  it("falls back to no attribution on a detached HEAD (raw SHA content)", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n");

    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({ index });

    const result = attribute({ cwd: dir });

    expect(result).toEqual({});
  });

  it("falls back to no attribution when .git is a file (worktree/submodule shape)", () => {
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/example\n");

    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({ index });

    const result = attribute({ cwd: dir });

    expect(result).toEqual({});
  });

  it("falls back to no attribution when .git does not exist at all (e.g. cwd is a repo subdirectory)", () => {
    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({ index });

    const result = attribute({ cwd: join(dir, "no-such-git-here") });

    expect(result).toEqual({});
  });

  it("caches the branch lookup per cwd for the injected TTL (60s) and refreshes only once expired", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/org-a/feature\n");

    const index = makeIndex({ branchOrgs: ["org-a", "org-b"] });
    let currentNow = 0;
    const attribute = createAttributor({ index, now: () => currentNow });

    expect(attribute({ cwd: dir })).toEqual({ org: "org-a" });

    // simulate a branch switch on disk without advancing past the 60s TTL —
    // the cached value must still be served.
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/org-b/feature\n");
    currentNow = 59_999;
    expect(attribute({ cwd: dir })).toEqual({ org: "org-a" });

    // advance past the TTL — the next lookup must re-read the file.
    currentNow = 60_000;
    expect(attribute({ cwd: dir })).toEqual({ org: "org-b" });
  });
});

describe("createAttributor — rule 3 (subagent_type)", () => {
  it("attributes org/dept/role when tool_input.subagent_type matches", () => {
    const index = makeIndex({
      subagents: {
        "tech-researcher": { org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" },
      },
    });
    const attribute = createAttributor({ index });

    const result = attribute({ tool_input: { subagent_type: "tech-researcher" } });

    expect(result).toEqual({
      org: "domain-tech-collection",
      dept: "dept-research",
      role: "tech-researcher",
    });
  });

  it("takes priority over rule 1/2 (overrides the org that cwd would have produced)", () => {
    const index = makeIndex({
      repoPrefixes: [{ prefix: "/some/repo", org: "org-from-cwd" }],
      subagents: {
        "tech-researcher": { org: "org-from-subagent", dept: "dept-research", role: "tech-researcher" },
      },
    });
    const attribute = createAttributor({ index });

    const result = attribute({
      cwd: "/some/repo",
      tool_input: { subagent_type: "tech-researcher" },
    });

    expect(result).toEqual({
      org: "org-from-subagent",
      dept: "dept-research",
      role: "tech-researcher",
    });
  });

  it("returns no fields when subagent_type does not match any known entry", () => {
    const index = makeIndex({
      subagents: {
        "tech-researcher": { org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" },
      },
    });
    const attribute = createAttributor({ index });

    const result = attribute({ tool_input: { subagent_type: "unknown-subagent" } });

    expect(result).toEqual({});
  });

  it("ignores a non-string / missing subagent_type without throwing", () => {
    const index = makeIndex({
      subagents: { "tech-researcher": { org: "o", dept: "d", role: "r" } },
    });
    const attribute = createAttributor({ index });

    expect(attribute({ tool_input: {} })).toEqual({});
    expect(attribute({ tool_input: { subagent_type: 123 } })).toEqual({});
    expect(attribute({ tool_input: "not an object" })).toEqual({});
  });
});

describe("createAttributor — rule 4 (no match)", () => {
  it("returns an empty object (no keys at all) when nothing matches", () => {
    const index = makeIndex();
    const attribute = createAttributor({ index });

    const result = attribute({ cwd: "/nowhere", tool_input: { subagent_type: "nope" } });

    expect(Object.keys(result)).toEqual([]);
  });

  it("handles raw being null/undefined/non-object without throwing", () => {
    const index = makeIndex();
    const attribute = createAttributor({ index });

    expect(() => attribute(null)).not.toThrow();
    expect(() => attribute(undefined)).not.toThrow();
    expect(() => attribute("not an object")).not.toThrow();
    expect(attribute(null)).toEqual({});
  });
});

describe("resolveAttributionPath", () => {
  it("uses AI_OFFICE_ATTRIBUTION_PATH when set", () => {
    const path = resolveAttributionPath({
      AI_OFFICE_ATTRIBUTION_PATH: "/custom/dir/attribution.json",
    } as NodeJS.ProcessEnv);

    expect(path).toBe("/custom/dir/attribution.json");
  });

  it("falls back to ~/.ai-office/layouts/attribution.json when unset", () => {
    const path = resolveAttributionPath({} as NodeJS.ProcessEnv);

    expect(path).toBe(join(homedir(), ".ai-office", "layouts", "attribution.json"));
  });
});

describe("loadAttributor", () => {
  const validIndex = {
    version: 1,
    repoPrefixes: [{ prefix: "/some/repo", org: "domain-tech-collection" }],
    branchOrgs: [],
    subagents: {},
    receptionDept: {},
  };

  it("builds a working attributor from a valid attribution.json (via injected readFileSync)", () => {
    const attribute = loadAttributor({
      path: "/fake/attribution.json",
      readFileSync: () => JSON.stringify(validIndex),
      log: () => {},
    });

    expect(attribute({ cwd: "/some/repo" })).toEqual({ org: "domain-tech-collection" });
  });

  it("returns a no-op attributor and logs the path (not content) when the file does not exist", () => {
    const logs: string[] = [];
    const attribute = loadAttributor({
      path: "/fake/does-not-exist/attribution.json",
      readFileSync: () => {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
      log: (message) => logs.push(message),
    });

    expect(attribute({ cwd: "/some/repo" })).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("/fake/does-not-exist/attribution.json");
  });

  it("returns a no-op attributor when the file contains invalid JSON", () => {
    const logs: string[] = [];
    const attribute = loadAttributor({
      path: "/fake/attribution.json",
      readFileSync: () => "{not valid json",
      log: (message) => logs.push(message),
    });

    expect(attribute({ cwd: "/some/repo" })).toEqual({});
    expect(logs).toHaveLength(1);
  });

  it("returns a no-op attributor when the file fails AttributionIndexSchema validation", () => {
    const logs: string[] = [];
    const attribute = loadAttributor({
      path: "/fake/attribution.json",
      readFileSync: () => JSON.stringify({ version: 1, repoPrefixes: "not an array" }),
      log: (message) => logs.push(message),
    });

    expect(attribute({ cwd: "/some/repo" })).toEqual({});
    expect(logs).toHaveLength(1);
  });

  it("never includes cwd or file content in the diagnostic log line", () => {
    const logs: string[] = [];
    loadAttributor({
      path: "/fake/attribution.json",
      readFileSync: () => "{not valid json, secret-project-name-should-not-leak",
      log: (message) => logs.push(message),
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("secret-project-name-should-not-leak");
  });
});

describe("createAttributor — NFR-4 (cwd must never leak into logs/errors)", () => {
  it("never calls console.error/warn/log even when the default readBranch hits a filesystem error", () => {
    const errors: unknown[] = [];
    const warns: unknown[] = [];
    const logs: unknown[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => errors.push(args);
    console.warn = (...args: unknown[]) => warns.push(args);
    console.log = (...args: unknown[]) => logs.push(args);

    try {
      const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
      const attribute = createAttributor({ index });
      attribute({ cwd: "/definitely/does/not/exist/secret-project-name" });
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
      console.log = originalLog;
    }

    expect(errors).toHaveLength(0);
    expect(warns).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("does not throw an exception whose message contains the cwd", () => {
    const index = makeIndex({ branchOrgs: ["domain-tech-collection"] });
    const attribute = createAttributor({ index });

    expect(() => attribute({ cwd: "/definitely/does/not/exist/secret-project-name" })).not.toThrow();
  });
});
