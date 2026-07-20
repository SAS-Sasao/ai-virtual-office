import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

// AC-10 の①: dependencies が空であること（配布物に workspace 依存を持ち込まない）。
describe("packages/cli/package.json", () => {
  it("dependencies が空オブジェクトである", () => {
    expect(pkg.dependencies).toEqual({});
  });

  it("@ai-office/relay は devDependencies にのみ存在する（配布物の依存には含まれない）", () => {
    expect(pkg.devDependencies["@ai-office/relay"]).toBe("workspace:*");
    expect(pkg.dependencies["@ai-office/relay"]).toBeUndefined();
  });

  it("bin は ai-office コマンドを dist/index.js にマップする", () => {
    expect(pkg.bin).toEqual({ "ai-office": "./dist/index.js" });
  });

  it("name は ai-office（npx ai-office で起動できる名前）", () => {
    expect(pkg.name).toBe("ai-office");
  });
});
