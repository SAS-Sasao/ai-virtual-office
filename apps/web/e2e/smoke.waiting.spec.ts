import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { OfficeEvent } from "@ai-office/protocol";

const RELAY_INJECT_URL = "http://localhost:4105/test/inject";

/** リポジトリ直下 fixtures/e2e/*.jsonl（シード付き OfficeEvent 列）を読む。 */
function loadFixture(name: string): OfficeEvent[] {
  const path = resolve(__dirname, "../../../fixtures/e2e", name);
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OfficeEvent);
}

/** 実経路（test relay 4105 → forward 3100 の /api/ingest → SSE）で fixture を注入する。 */
async function inject(request: APIRequestContext, events: OfficeEvent[]): Promise<void> {
  const res = await request.post(RELAY_INJECT_URL, { data: events });
  expect(res.ok(), `relay /test/inject が失敗しました: ${res.status()}`).toBeTruthy();
}

// @smoke ③（AC-4）: notification fixture 注入で、Debug State API の
// pendingNotifications>=1 かつ UI の WaitingPanel（見出し「許可待ち」の section）に
// 行が出る。pendingNotifications と待ちパネル件数は同じ述語（state==="waiting"）
// から導出されるため常に一致する（M1-4b AC-5）。
test("@smoke waiting: notification で pendingNotifications>=1 かつ待ちパネルに行が出る", async ({ page, request }) => {
  const events = loadFixture("waiting.jsonl");

  await page.goto("/?e2e=1");
  await page.waitForFunction(() => !!window.__OFFICE_DEBUG__);

  await inject(request, events);

  await page.waitForFunction(() => {
    const state = window.__OFFICE_DEBUG__?.getState();
    return !!state && state.pendingNotifications >= 1;
  });

  const state = await page.evaluate(() => window.__OFFICE_DEBUG__!.getState());
  expect(state.pendingNotifications).toBeGreaterThanOrEqual(1);

  // WaitingPanel は「許可待ち」見出しを持つ section。空のときは <li> を描かず
  // 案内文の <p> のみになるため、listitem>=1 で「行が出た」ことを判定できる。
  const waitingPanel = page.locator("section", {
    has: page.getByRole("heading", { name: "許可待ち" }),
  });
  await expect(waitingPanel.getByRole("listitem")).toHaveCount(1);
});
