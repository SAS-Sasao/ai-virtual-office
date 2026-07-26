import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OfficeEventSchema } from "./events.js";

// リポジトリ直下 fixtures/e2e/*.jsonl（E2E @smoke が /test/inject へ流す
// シード付き OfficeEvent 列）が protocol スキーマと乖離していないことを、
// スキーマの正本（本パッケージ）側で機械検証する（fixture 腐敗の早期検出）。
// M1-5 設計メモ「fixtures/e2e/」の unit 要件。FR-5 リプレイと共通フォーマット。
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "e2e");

function jsonlFiles(): string[] {
  return readdirSync(fixturesDir).filter((name) => name.endsWith(".jsonl"));
}

describe("fixtures/e2e/*.jsonl", () => {
  it("少なくとも 1 本の fixture が存在する", () => {
    expect(jsonlFiles().length).toBeGreaterThanOrEqual(1);
  });

  for (const file of jsonlFiles()) {
    it(`${file} の全行が OfficeEventSchema を通る`, () => {
      const raw = readFileSync(join(fixturesDir, file), "utf-8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const [index, line] of lines.entries()) {
        const parsed = OfficeEventSchema.safeParse(JSON.parse(line));
        expect(parsed.success, `${file}:${index + 1} が schema 不一致: ${parsed.success ? "" : parsed.error.message}`).toBe(
          true,
        );
      }
    });
  }
});
