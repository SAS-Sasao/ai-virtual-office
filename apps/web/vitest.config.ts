import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["game/**/*.test.ts", "lib/**/*.test.ts"],
    environment: "node",
  },
});
