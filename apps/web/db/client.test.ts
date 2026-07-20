import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, resolveDbPath } from "./client";
import { events } from "./schema";

describe("resolveDbPath", () => {
  it("uses AI_OFFICE_DB_PATH when set", () => {
    const path = resolveDbPath({ AI_OFFICE_DB_PATH: "/custom/dir/events.db" } as unknown as NodeJS.ProcessEnv);
    expect(path).toBe("/custom/dir/events.db");
  });

  it("falls back to ~/.ai-office/events.db when AI_OFFICE_DB_PATH is unset", () => {
    const path = resolveDbPath({} as unknown as NodeJS.ProcessEnv);
    expect(path.endsWith(join(".ai-office", "events.db"))).toBe(true);
    expect(path).not.toBe(join(".ai-office", "events.db"));
  });
});

describe("createDb", () => {
  it("returns a usable Db for :memory: (never touches disk)", () => {
    const db = createDb(":memory:");
    expect(db).not.toBeNull();
  });

  it("initializes the events table (CREATE TABLE IF NOT EXISTS) so it is queryable immediately", () => {
    const db = createDb(":memory:");
    expect(db).not.toBeNull();
    expect(() => db?.select().from(events).all()).not.toThrow();
    expect(db?.select().from(events).all()).toEqual([]);
  });

  it("returns null (does not throw) when the path cannot be initialized", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-web-db-test-"));
    const blockerFile = join(dir, "blocker"); // a *file*, not a directory
    writeFileSync(blockerFile, "not a directory");
    const impossiblePath = join(blockerFile, "sub", "events.db"); // mkdir under a file -> ENOTDIR

    expect(() => createDb(impossiblePath)).not.toThrow();
    expect(createDb(impossiblePath)).toBeNull();
  });
});
