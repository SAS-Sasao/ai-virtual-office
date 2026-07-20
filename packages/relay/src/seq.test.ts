import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPersistentSeqCounter,
  createSeqCounter,
  resolveSeqPath,
  type SeqStateIO,
} from "./seq.js";

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

describe("resolveSeqPath", () => {
  it("uses AI_OFFICE_SEQ_PATH when set", () => {
    const path = resolveSeqPath({ AI_OFFICE_SEQ_PATH: "/custom/dir/seq.json" } as NodeJS.ProcessEnv);
    expect(path).toBe("/custom/dir/seq.json");
  });

  it("falls back to ~/.ai-office/relay-seq.json when AI_OFFICE_SEQ_PATH is unset", () => {
    const path = resolveSeqPath({} as NodeJS.ProcessEnv);
    expect(path.endsWith(join(".ai-office", "relay-seq.json"))).toBe(true);
    // must not itself resolve into a path under the repo/CWD — it is homedir-based.
    expect(path).not.toBe(join(".ai-office", "relay-seq.json"));
  });
});

describe("createPersistentSeqCounter", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    // NFR-2 / 本番非破壊: 必ず mkdtemp 配下のみを使い、~/.ai-office/ には一切触れない。
    dir = mkdtempSync(join(tmpdir(), "ai-office-relay-seq-test-"));
    filePath = join(dir, "relay-seq.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reserves a block of 1000 on the first call and persists it to the state file immediately", () => {
    const nextSeq = createPersistentSeqCounter({ path: filePath });

    expect(nextSeq()).toBe(0);

    const saved = JSON.parse(readFileSync(filePath, "utf8")) as { lastSeq: number };
    expect(saved).toEqual({ lastSeq: 1000 });
  });

  it("issues a monotonically increasing sequence within the reserved block without further I/O", () => {
    const nextSeq = createPersistentSeqCounter({ path: filePath });

    expect(nextSeq()).toBe(0);
    expect(nextSeq()).toBe(1);
    expect(nextSeq()).toBe(2);

    // block was already reserved on the first call; the file must not have advanced further.
    const saved = JSON.parse(readFileSync(filePath, "utf8")) as { lastSeq: number };
    expect(saved).toEqual({ lastSeq: 1000 });
  });

  it("reserves the next block only after the current block is exhausted (custom small blockSize)", () => {
    const nextSeq = createPersistentSeqCounter({ path: filePath, blockSize: 3 });

    expect(nextSeq()).toBe(0);
    expect(nextSeq()).toBe(1);
    expect(nextSeq()).toBe(2);
    let saved = JSON.parse(readFileSync(filePath, "utf8")) as { lastSeq: number };
    expect(saved).toEqual({ lastSeq: 3 });

    // 4th call exceeds the reserved [0,3) block -> triggers reservation of the next block [3,6).
    expect(nextSeq()).toBe(3);
    saved = JSON.parse(readFileSync(filePath, "utf8")) as { lastSeq: number };
    expect(saved).toEqual({ lastSeq: 6 });
  });

  it("consumes exactly 1000 seq values from a block before reserving the next one by default", () => {
    const nextSeq = createPersistentSeqCounter({ path: filePath });

    for (let i = 0; i < 1000; i += 1) {
      expect(nextSeq()).toBe(i);
    }
    let saved = JSON.parse(readFileSync(filePath, "utf8")) as { lastSeq: number };
    expect(saved).toEqual({ lastSeq: 1000 });

    expect(nextSeq()).toBe(1000);
    saved = JSON.parse(readFileSync(filePath, "utf8")) as { lastSeq: number };
    expect(saved).toEqual({ lastSeq: 2000 });
  });

  it("resumes from a value greater than the previously issued max after a simulated relay restart", () => {
    const first = createPersistentSeqCounter({ path: filePath, blockSize: 5 });
    const issuedByFirst = [first(), first(), first()];
    const maxIssuedByFirst = Math.max(...issuedByFirst);

    // simulate a relay restart: a brand-new counter instance reading the same state file.
    const second = createPersistentSeqCounter({ path: filePath, blockSize: 5 });
    const firstFromSecond = second();

    expect(firstFromSecond).toBeGreaterThan(maxIssuedByFirst);
    // the second instance must not reuse [0,5) — it reserves the next block [5,10).
    expect(firstFromSecond).toBe(5);
  });

  it("returns undefined (never throws) when the state file cannot be read, and never writes", () => {
    const writeState = vi.fn();
    const io: SeqStateIO = {
      readState: () => {
        throw new Error("EACCES: permission denied");
      },
      writeState,
    };
    const nextSeq = createPersistentSeqCounter({ path: filePath, io });

    expect(nextSeq()).toBeUndefined();
    expect(nextSeq()).toBeUndefined();
    expect(writeState).not.toHaveBeenCalled();
  });

  it("returns undefined (never throws) when the state file cannot be written", () => {
    const io: SeqStateIO = {
      readState: () => undefined,
      writeState: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    };
    const nextSeq = createPersistentSeqCounter({ path: filePath, io });

    expect(nextSeq()).toBeUndefined();
  });

  it("never restarts from 0 after a read failure — it does not fabricate a lower value than what may already be persisted", () => {
    const io: SeqStateIO = {
      readState: () => {
        throw new Error("corrupt state file");
      },
      writeState: vi.fn(),
    };
    const nextSeq = createPersistentSeqCounter({ path: filePath, io });

    const first = nextSeq();
    const second = nextSeq();
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
  });

  it("retries reservation on a later call after a transient failure recovers", () => {
    let shouldFail = true;
    let lastSeq = 0;
    const io: SeqStateIO = {
      readState: () => {
        if (shouldFail) {
          throw new Error("transient failure");
        }
        return { lastSeq };
      },
      writeState: (state) => {
        if (shouldFail) {
          throw new Error("transient failure");
        }
        lastSeq = state.lastSeq;
      },
    };
    const nextSeq = createPersistentSeqCounter({ path: filePath, io, blockSize: 10 });

    expect(nextSeq()).toBeUndefined();
    shouldFail = false;
    expect(nextSeq()).toBe(0);
    expect(nextSeq()).toBe(1);
  });
});
