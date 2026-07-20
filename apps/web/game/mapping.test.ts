import { describe, expect, it } from "vitest";
import { toolToState } from "./mapping";

describe("toolToState", () => {
  it.each([
    ["Edit", "type"],
    ["Write", "type"],
    ["NotebookEdit", "type"],
  ] as const)("%s -> %s", (toolName, expected) => {
    expect(toolToState(toolName)).toBe(expected);
  });

  it.each([
    ["Read", "read"],
    ["Glob", "read"],
    ["Grep", "read"],
  ] as const)("%s -> %s", (toolName, expected) => {
    expect(toolToState(toolName)).toBe(expected);
  });

  it("Bash -> terminal", () => {
    expect(toolToState("Bash")).toBe("terminal");
  });

  it.each([
    ["WebFetch", "browsing"],
    ["WebSearch", "browsing"],
  ] as const)("%s -> %s", (toolName, expected) => {
    expect(toolToState(toolName)).toBe(expected);
  });

  it("Task -> type", () => {
    expect(toolToState("Task")).toBe("type");
  });

  it("undefined -> thinking", () => {
    expect(toolToState(undefined)).toBe("thinking");
  });

  it("unknown tool name -> thinking", () => {
    expect(toolToState("SomeUnknownTool")).toBe("thinking");
  });
});
