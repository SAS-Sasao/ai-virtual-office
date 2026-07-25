import { describe, expect, it } from "vitest";
import { compareCodePoint } from "./sort-util.js";

describe("compareCodePoint", () => {
  it("sorts identically to the default (comparator-less) Array.prototype.sort() on strings", () => {
    const ids = ["a_z", "a-z", "B-y"];
    const withDefaultSort = [...ids].sort();
    const withCompareCodePoint = [...ids].sort(compareCodePoint);
    expect(withCompareCodePoint).toEqual(withDefaultSort);
  });

  it("disagrees with String.prototype.localeCompare for this exact id set (regression fixture for the locale-order bug)", () => {
    const ids = ["a_z", "a-z", "B-y"];
    const withLocaleCompare = [...ids].sort((a, b) => a.localeCompare(b));
    const withCompareCodePoint = [...ids].sort(compareCodePoint);
    expect(withCompareCodePoint).not.toEqual(withLocaleCompare);
    expect(withCompareCodePoint).toEqual(["B-y", "a-z", "a_z"]);
  });

  it("returns 0 for equal strings, negative when a < b, positive when a > b", () => {
    expect(compareCodePoint("a", "a")).toBe(0);
    expect(compareCodePoint("a", "b")).toBeLessThan(0);
    expect(compareCodePoint("b", "a")).toBeGreaterThan(0);
  });
});
