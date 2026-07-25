import { describe, expect, it } from "vitest";
import { AttributionIndexSchema, type AttributionIndex } from "./attribution.js";

describe("AttributionIndexSchema", () => {
  const valid = {
    version: 1,
    repoPrefixes: [{ prefix: "/home/toyoki05/cc-sier-organization", org: "domain-tech-collection" }],
    branchOrgs: ["domain-tech-collection", "jutaku-dev-team", "standardization-initiative"],
    subagents: {
      "tech-researcher": { org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" },
    },
    receptionDept: { "domain-tech-collection": "dept-secretary" },
  };

  it("parses a full valid attribution index", () => {
    const result = AttributionIndexSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("accepts empty repoPrefixes/branchOrgs/subagents/receptionDept (nothing resolvable yet)", () => {
    const input = { version: 1, repoPrefixes: [], branchOrgs: [], subagents: {}, receptionDept: {} };
    const result = AttributionIndexSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects a version other than 1", () => {
    const result = AttributionIndexSchema.safeParse({ ...valid, version: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects a repoPrefixes entry missing 'org'", () => {
    const result = AttributionIndexSchema.safeParse({
      ...valid,
      repoPrefixes: [{ prefix: "/some/path" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty prefix string", () => {
    const result = AttributionIndexSchema.safeParse({
      ...valid,
      repoPrefixes: [{ prefix: "", org: "domain-tech-collection" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a subagents entry missing a required field (dept)", () => {
    const result = AttributionIndexSchema.safeParse({
      ...valid,
      subagents: { secretary: { org: "domain-tech-collection", role: "secretary" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string branchOrgs entry", () => {
    const result = AttributionIndexSchema.safeParse({ ...valid, branchOrgs: [123] });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string receptionDept value", () => {
    const result = AttributionIndexSchema.safeParse({
      ...valid,
      receptionDept: { "domain-tech-collection": 42 },
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown top-level keys", () => {
    const input = { ...valid, generatedAt: "2026-07-25" };
    const result = AttributionIndexSchema.parse(input);
    expect(result).not.toHaveProperty("generatedAt");
  });

  it("strips unknown keys from a subagents entry", () => {
    const input = {
      ...valid,
      subagents: {
        "tech-researcher": {
          org: "domain-tech-collection",
          dept: "dept-research",
          role: "tech-researcher",
          model: "sonnet",
        },
      },
    };
    const result = AttributionIndexSchema.parse(input);
    expect(result.subagents["tech-researcher"]).not.toHaveProperty("model");
  });

  it("infers an AttributionIndex type usable as a literal", () => {
    const index: AttributionIndex = valid;
    expect(AttributionIndexSchema.safeParse(index).success).toBe(true);
  });
});
