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

// @smoke ②（AC-3）: fixture 注入 → waitForIdle → 対象セッションが期待遷移
// （idle -> type）に到達する。壁時計の「1 秒以内」は判定に使わない（設計メモ
// finding 6）。fast-mode（?e2e=1）+ fixture シードで決定論的な到達のみを assert。
test("@smoke inject: fixture 注入で対象セッションが idle->type に到達する", async ({ page, request }) => {
  const events = loadFixture("inject-type.jsonl");
  const sessionId = "e2e-inject-001";

  await page.goto("/?e2e=1");
  await page.waitForFunction(() => !!window.__OFFICE_DEBUG__);

  await inject(request, events);

  // SSE 配信 + fast-mode 歩行完了を決定論的に待つ（sleep 不使用）。
  await page.waitForFunction(
    (sid) => {
      const state = window.__OFFICE_DEBUG__?.getState();
      if (!state) return false;
      const target = state.characters.find((c) => c.sessionId === sid);
      return !!target && target.state === "type";
    },
    sessionId,
  );

  await page.evaluate(() => window.__OFFICE_DEBUG__!.waitForIdle());

  const state = await page.evaluate(() => window.__OFFICE_DEBUG__!.getState());
  const target = state.characters.find((c) => c.sessionId === sessionId);
  expect(target, "対象セッションのキャラクターが存在する").toBeTruthy();
  expect(target?.state).toBe("type");
});
