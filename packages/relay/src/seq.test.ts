import { describe, expect, it } from "vitest";
import { createSeqCounter } from "./seq.js";

describe("createSeqCounter", () => {
  it("defaults to starting at 0 and increments by 1 on each call", () => {
    const nextSeq = createSeqCounter();
    expect(nextSeq()).toBe(0);
    expect(nextSeq()).toBe(1);
    expect(nextSeq()).toBe(2);
  });

  it("accepts a custom start value", () => {
    const nextSeq = createSeqCounter(10);
    expect(nextSeq()).toBe(10);
    expect(nextSeq()).toBe(11);
  });

  it("keeps independent state across separately created counters (no shared globals)", () => {
    const a = createSeqCounter();
    const b = createSeqCounter();
    expect(a()).toBe(0);
    expect(a()).toBe(1);
    expect(b()).toBe(0);
  });
});
