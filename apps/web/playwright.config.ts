import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { snapshotNextManagedFiles } from "./e2e-teardown";

// M1-5 E2E ハーネス（設計メモ「apps/web — E2E ハーネス」/ 受入基準 AC-1〜11）。
//
// 本番非破壊・決定論の要:
// - web は **`next dev`（非 production）**で起動する。`next build`+`next start` は
//   NODE_ENV=production を強制し、Debug State API（game/debug.ts の attachDebug が
//   production で早期 return）が tree-shake され `window.__OFFICE_DEBUG__` が
//   未定義になるため、@smoke が全滅する（設計メモ finding 1）。
// - 専用ポート web=3100 / relay=4105 で dogfooding（3001/4100）と完全分離する。
// - web の DB は `:memory:`、layouts は空の一時ディレクトリに固定し、本番
//   `~/.ai-office/{events.db,layouts}` を一切汚さない（AC-11）。空 layouts で
//   フォールバック単一フロアに決定化し、キャラは fixture 注入で生成する。
// - relay は test モード（/test/inject 有効）で、forward 先を **明示的に 3100** に
//   向ける（既定 3001 のままだと本番 web/DB を汚す。設計メモ finding 2）。seq 状態も
//   一時ディレクトリへ隔離し、dogfooding relay の ~/.ai-office/relay-seq.json を
//   共有しない（/test/inject は seq を採番しないため実際には触らないが、verify.sh と
//   同じ隔離規律に揃える）。
// - `.next-e2e` に distDir を分離し、dogfooding の `.next` / verify.sh の
//   `.next-verify` と webpack chunk が衝突しないようにする（設計メモ finding 低）。

const emptyLayoutsDir = mkdtempSync(join(tmpdir(), "ai-office-e2e-layouts-"));
const relayStateDir = mkdtempSync(join(tmpdir(), "ai-office-e2e-relay-"));

// webServer（next dev）が tsconfig.json / next-env.d.ts を .next-e2e 向けに
// 書き換える前に pristine をスナップショットし、globalTeardown で復元する。
snapshotNextManagedFiles();

export default defineConfig({
  testDir: "e2e",
  globalTeardown: "./e2e-teardown.ts",
  // @smoke は決定論前提（fixture シード + waitForIdle + ?e2e=1）。並行実行による
  // 共有サーバ状態の相互干渉を避けるため worker は 1 本に固定する（3 本・数秒で
  // 60 秒予算内。AC-5/AC-6）。
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 10_000,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // 検証用 web（非 production・専用ポート・:memory: DB・空 layouts・専用 distDir）。
      command: "pnpm exec next dev -p 3100",
      url: "http://localhost:3100",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        AI_OFFICE_DB_PATH: ":memory:",
        AI_OFFICE_LAYOUTS_DIR: emptyLayoutsDir,
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
    {
      // 検証用 Relay（test モード・専用ポート・forward=3100・seq 状態を隔離）。
      command: "node ../../packages/relay/dist/cli.js",
      url: "http://localhost:4105/health",
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        AI_OFFICE_TEST_MODE: "1",
        AI_OFFICE_RELAY_PORT: "4105",
        AI_OFFICE_FORWARD_URL: "http://localhost:3100/api/ingest",
        AI_OFFICE_SEQ_PATH: join(relayStateDir, "relay-seq.json"),
      },
    },
  ],
});
