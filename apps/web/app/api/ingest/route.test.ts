import { describe, expect, it } from "vitest";
import { subscribe, type OfficeEventListener } from "../../../lib/bus";
import { POST } from "./route";

function jsonRequest(body: unknown, rawBody?: string): Request {
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody ?? JSON.stringify(body),
  });
}

/**
 * lib/bus.ts はテストプロセス全体で共有される globalThis シングルトンのため、
 * 各テストで subscribe → 検証 → 必ず unsubscribe して購読リークを防ぐ。
 */
function collectPublished(): { received: unknown[]; unsubscribe: () => void } {
  const received: unknown[] = [];
  const listener: OfficeEventListener = (ev) => received.push(ev);
  const unsubscribe = subscribe(listener);
  return { received, unsubscribe };
}

describe("POST /api/ingest", () => {
  it("正規化済み OfficeEvent を受理し 200 + ignored:false を返し、bus に publish する", async () => {
    const { received, unsubscribe } = collectPublished();

    const event = { type: "session_start", sessionId: "s1", ts: 1_700_000_000_000 };
    const res = await POST(jsonRequest(event));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: false });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("生 hooks JSON（hook_event_name 形式）は受理しない（200 + ignored:true、publish されない）", async () => {
    const { received, unsubscribe } = collectPublished();

    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "session-abc",
      tool_name: "Edit",
      tool_input: { file_path: "/home/user/secret/App.tsx" },
    };
    const res = await POST(jsonRequest(raw));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(received).toHaveLength(0);
  });

  it("パース不能な JSON でも 200 + ignored:true を返す", async () => {
    const { received, unsubscribe } = collectPublished();

    const res = await POST(jsonRequest(undefined, "{not valid json"));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(received).toHaveLength(0);
  });

  it("未知フィールド入り OfficeEvent は受理されるが、publish されるオブジェクトから未知フィールドが strip される", async () => {
    const { received, unsubscribe } = collectPublished();

    const event = {
      type: "user_prompt",
      sessionId: "s1",
      ts: 1,
      prompt: "must be stripped before publish",
    };
    const res = await POST(jsonRequest(event));

    unsubscribe();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: false });
    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty("prompt");
    expect(Object.keys(received[0] as object).sort()).toEqual(["sessionId", "ts", "type"]);
  });
});
