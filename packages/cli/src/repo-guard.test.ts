import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isInsideNamedRepo } from "./repo-guard.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

describe("isInsideNamedRepo", () => {
  it("AC-11d: 本リポジトリのサブディレクトリ（packages/relay）から上方探索すると true", () => {
    const nestedDir = join(REPO_ROOT, "packages", "relay");
    expect(isInsideNamedRepo(nestedDir, "ai-virtual-office")).toBe(true);
  });

  it("さらに深いサブディレクトリ（packages/relay/src）からも検出する", () => {
    const nestedDir = join(REPO_ROOT, "packages", "relay", "src");
    expect(isInsideNamedRepo(nestedDir, "ai-virtual-office")).toBe(true);
  });

  it("最も近い package.json の name が一致しなくても、さらに上方の祖先で一致すれば true", () => {
    // packages/cli/package.json の name は "ai-office" であり、"ai-virtual-office" とは異なる。
    // それでもリポジトリルートまで探索を続けて検出できることを確認する。
    const nestedDir = join(REPO_ROOT, "packages", "cli");
    expect(isInsideNamedRepo(nestedDir, "ai-virtual-office")).toBe(true);
  });

  it("無関係なディレクトリでは false", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-repo-guard-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "some-other-project" }), "utf-8");
      expect(isInsideNamedRepo(dir, "ai-virtual-office")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("package.json が全く無い（浅い）ディレクトリでも例外を投げず false を返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-repo-guard-none-"));
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    try {
      expect(isInsideNamedRepo(nested, "ai-virtual-office")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("壊れた package.json は無視して上方探索を継続する", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-office-repo-guard-broken-"));
    try {
      const nested = join(dir, "child");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "package.json"), "{ not valid json", "utf-8");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ai-virtual-office" }), "utf-8");

      expect(isInsideNamedRepo(nested, "ai-virtual-office")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
