import { expect, test } from "@playwright/test";
import type { DebugState } from "../game/debug";

// @smoke ①（AC-2）: アプリが起動し、Debug State API（NFR-8）が例外なく
// floors>=1 で解決する。空 layouts（playwright.config）ではフォールバック単一
// フロア（org="default"）が 1 件返るため floors.length は決定論的に 1 以上になる。
// 決定論ルール（e2e-authoring）: sleep せず waitForFunction で API 露出を待つ。
test("@smoke boot: Debug State API が floors>=1 で解決する", async ({ page }) => {
  await page.goto("/?e2e=1");

  await page.waitForFunction(() => {
    const api = window.__OFFICE_DEBUG__;
    if (!api) return false;
    return api.getState().floors.length >= 1;
  });

  const state: DebugState = await page.evaluate(() => window.__OFFICE_DEBUG__!.getState());
  expect(state.floors.length).toBeGreaterThanOrEqual(1);
});
