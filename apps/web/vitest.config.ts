import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["game/**/*.test.ts", "lib/**/*.test.ts", "app/**/*.test.ts", "db/**/*.test.ts"],
    environment: "node",
    // NFR-2 / 本番非破壊: テスト実行中は絶対に ~/.ai-office/events.db を作らない。
    // db/*.test.ts は createDb(":memory:") を明示的に使うが、ingest/stream の
    // route.test.ts が既定パス解決経由で getDb() を呼んだ場合の保険として、
    // テストプロセス全体を :memory: に固定する。
    env: {
      AI_OFFICE_DB_PATH: ":memory:",
    },
  },
});
