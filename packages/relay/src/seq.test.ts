import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFsSeqStateIO,
  createPersistentSeqCounter,
  createSeqCounter,
  resolveSeqPath,
  type SeqStateIO,
  type SeqWriteFsFacade,
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

describe("createFsSeqStateIO (fs facade DI — AC-1/AC-2)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    // NFR-2 / 本番非破壊: 必ず mkdtemp 配下のみを使い、~/.ai-office/ には一切触れない。
    dir = mkdtempSync(join(tmpdir(), "ai-office-relay-seq-fsio-test-"));
    filePath = join(dir, "relay-seq.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 呼び出し順序を記録するだけの偽 fs ファサード。実際のディスク I/O は
   * 一切行わないため、「tmp write → fsync → rename」という契約自体を
   * `writeState` の実装（`createFsSeqStateIO` の高位シームではなく低位の
   * fs facade）で検証できる（rev.1 review F1 対応）。
   */
  function makeFakeFacade(overrides: Partial<SeqWriteFsFacade> = {}) {
    const calls: string[] = [];
    let nextFd = 1;
    const facade: SeqWriteFsFacade = {
      mkdirSync: vi.fn((...args) => {
        calls.push("mkdirSync");
        return undefined as unknown as ReturnType<typeof import("node:fs").mkdirSync>;
      }) as unknown as SeqWriteFsFacade["mkdirSync"],
      openSync: vi.fn(() => {
        calls.push("openSync");
        return nextFd++;
      }) as unknown as SeqWriteFsFacade["openSync"],
      writeSync: vi.fn(() => {
        calls.push("writeSync");
        return 0;
      }) as unknown as SeqWriteFsFacade["writeSync"],
      fsyncSync: vi.fn(() => {
        calls.push("fsyncSync");
      }) as unknown as SeqWriteFsFacade["fsyncSync"],
      closeSync: vi.fn(() => {
        calls.push("closeSync");
      }) as unknown as SeqWriteFsFacade["closeSync"],
      renameSync: vi.fn(() => {
        calls.push("renameSync");
      }) as unknown as SeqWriteFsFacade["renameSync"],
      unlinkSync: vi.fn(() => {
        calls.push("unlinkSync");
      }) as unknown as SeqWriteFsFacade["unlinkSync"],
      ...overrides,
    };
    return { facade, calls };
  }

  it("writes to a <path>.tmp file, fsyncs it, then atomically renames it over the target path (AC-1)", () => {
    const { facade, calls } = makeFakeFacade();
    const io = createFsSeqStateIO(filePath, facade);

    io.writeState({ lastSeq: 42 });

    expect(calls).toEqual(["mkdirSync", "openSync", "writeSync", "fsyncSync", "closeSync", "renameSync"]);
    expect(facade.openSync).toHaveBeenCalledWith(`${filePath}.tmp`, "w");
    expect(facade.renameSync).toHaveBeenCalledWith(`${filePath}.tmp`, filePath);
  });

  it("fsyncs the written fd before the atomic rename (best-effort durability, AC-2)", () => {
    const { facade, calls } = makeFakeFacade();
    const io = createFsSeqStateIO(filePath, facade);

    io.writeState({ lastSeq: 1 });

    const fsyncIndex = calls.indexOf("fsyncSync");
    const renameIndex = calls.indexOf("renameSync");
    expect(fsyncIndex).toBeGreaterThanOrEqual(0);
    expect(fsyncIndex).toBeLessThan(renameIndex);
  });

  it("cleans up the .tmp file and rethrows when rename fails, leaving the original path untouched (AC-1)", () => {
    const { facade, calls } = makeFakeFacade({
      renameSync: vi.fn(() => {
        calls.push("renameSync");
        throw new Error("EXDEV: cross-device link not permitted");
      }) as unknown as SeqWriteFsFacade["renameSync"],
    });
    const io = createFsSeqStateIO(filePath, facade);

    expect(() => io.writeState({ lastSeq: 7 })).toThrow("EXDEV");
    expect(calls).toEqual([
      "mkdirSync",
      "openSync",
      "writeSync",
      "fsyncSync",
      "closeSync",
      "renameSync",
      "unlinkSync",
    ]);
    expect(facade.unlinkSync).toHaveBeenCalledWith(`${filePath}.tmp`);
    // the target path itself was never touched by this facade.
    expect(facade.writeSync).toHaveBeenCalledTimes(1);
  });

  it("does not mask the original rename error if the unlink cleanup itself fails", () => {
    const { facade } = makeFakeFacade({
      renameSync: vi.fn(() => {
        throw new Error("rename failed");
      }) as unknown as SeqWriteFsFacade["renameSync"],
      unlinkSync: vi.fn(() => {
        throw new Error("unlink also failed");
      }) as unknown as SeqWriteFsFacade["unlinkSync"],
    });
    const io = createFsSeqStateIO(filePath, facade);

    expect(() => io.writeState({ lastSeq: 1 })).toThrow("rename failed");
  });

  it("uses real node:fs by default: persists state atomically and leaves no leftover .tmp file (integration smoke)", () => {
    const io = createFsSeqStateIO(filePath);

    io.writeState({ lastSeq: 99 });

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ lastSeq: 99 });
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
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

  describe("blockSize validation (AC-3)", () => {
    it.each([0, -1, 1.5, -100.25, NaN])(
      "throws at construction time when blockSize=%s is not a positive integer",
      (blockSize) => {
        expect(() => createPersistentSeqCounter({ path: filePath, blockSize })).toThrow();
      },
    );

    it.each([1, 2, 1000])("accepts a valid integer blockSize=%s without throwing", (blockSize) => {
      expect(() => createPersistentSeqCounter({ path: filePath, blockSize })).not.toThrow();
    });

    it("still defaults to blockSize=1000 when omitted", () => {
      const nextSeq = createPersistentSeqCounter({ path: filePath });
      expect(nextSeq()).toBe(0);
      const saved = JSON.parse(readFileSync(filePath, "utf8")) as { lastSeq: number };
      expect(saved).toEqual({ lastSeq: 1000 });
    });
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
