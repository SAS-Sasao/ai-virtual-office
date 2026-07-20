import { describe, expect, it, vi } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { createServer, type CreateServerOptions } from "./server.js";

const NOW = 1_700_000_000_000;

const HOOK_PATHS = [
  "session-start",
  "user-prompt",
  "pre-tool",
  "post-tool",
  "notification",
  "stop",
  "subagent-stop",
  "session-end",
] as const;

const HOOK_BODY_FOR: Record<(typeof HOOK_PATHS)[number], unknown> = {
  "session-start": { hook_event_name: "SessionStart", session_id: "s1" },
  "user-prompt": { hook_event_name: "UserPromptSubmit", session_id: "s1" },
  "pre-tool": { hook_event_name: "PreToolUse", session_id: "s1" },
  "post-tool": { hook_event_name: "PostToolUse", session_id: "s1" },
  notification: { hook_event_name: "Notification", session_id: "s1" },
  stop: { hook_event_name: "Stop", session_id: "s1" },
  "subagent-stop": { hook_event_name: "SubagentStop", session_id: "s1" },
  "session-end": { hook_event_name: "SessionEnd", session_id: "s1" },
};

function postJson(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeServer(overrides: Partial<CreateServerOptions> = {}) {
  const forwarded: OfficeEvent[] = [];
  const defaultForward = async (event: OfficeEvent): Promise<void> => {
    forwarded.push(event);
  };

  const app = createServer({
    forward: defaultForward,
    now: () => NOW,
    testMode: false,
    ...overrides,
  });

  return { app, forwarded };
}

describe("POST /hooks/:event", () => {
  it.each(HOOK_PATHS)("%s は常に 200 を返す", async (path) => {
    const { app } = makeServer();
    const res = await app.request(postJson(`/hooks/${path}`, HOOK_BODY_FOR[path]));
    expect(res.status).toBe(200);
  });

  it("未知パスは 200 + ignored:true を返す", async () => {
    const { app, forwarded } = makeServer();
    const res = await app.request(
      postJson("/hooks/unknown-event", { hook_event_name: "Stop", session_id: "s1" }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(forwarded).toHaveLength(0);
  });

  it("不正 JSON body でも 200 + ignored:true を返す", async () => {
    const { app, forwarded } = makeServer();
    const res = await app.request(postJson("/hooks/pre-tool", "{not valid json"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(forwarded).toHaveLength(0);
  });

  it("normalize が null を返すイベントも 200 + ignored:true を返す", async () => {
    const { app, forwarded } = makeServer();
    // session_id が欠落 -> normalizeHookEvent は null を返す
    const res = await app.request(
      postJson("/hooks/pre-tool", { hook_event_name: "PreToolUse", tool_name: "Edit" }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(forwarded).toHaveLength(0);
  });

  it("forward が reject しても 200 を返す（NFR-2: hooks は絶対にブロックしない）", async () => {
    const forward = vi.fn(async (): Promise<void> => {
      throw new Error("boom");
    });
    const { app } = makeServer({ forward });

    const res = await app.request(postJson("/hooks/pre-tool", HOOK_BODY_FOR["pre-tool"]));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: false });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("forward に渡された event に seq が採番され、連続呼び出しで単調増加する", async () => {
    const { app, forwarded } = makeServer();

    await app.request(postJson("/hooks/pre-tool", HOOK_BODY_FOR["pre-tool"]));
    await app.request(postJson("/hooks/stop", HOOK_BODY_FOR.stop));
    await app.request(postJson("/hooks/session-end", HOOK_BODY_FOR["session-end"]));

    expect(forwarded).toHaveLength(3);
    expect(forwarded.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("POST /test/inject", () => {
  it("testMode=false のとき 404 を返す", async () => {
    const { app, forwarded } = makeServer({ testMode: false });

    const res = await app.request(postJson("/test/inject", []));

    expect(res.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it("testMode=true のとき OfficeEvent 配列を受理し、未知フィールドを strip して forward する", async () => {
    const { app, forwarded } = makeServer({ testMode: true });

    const events = [
      {
        type: "session_start",
        sessionId: "s1",
        ts: 1,
        prompt: "must be stripped before forwarding",
      },
    ];

    const res = await app.request(postJson("/test/inject", events));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, accepted: 1 });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).not.toHaveProperty("prompt");
    expect(Object.keys(forwarded[0]).sort()).toEqual(["sessionId", "ts", "type"]);
  });

  it("testMode=true でも不正要素混じりの配列は 400 かつ 1 件も forward されない（部分適用しない）", async () => {
    const { app, forwarded } = makeServer({ testMode: true });

    const events = [
      { type: "session_start", sessionId: "s1", ts: 1 },
      { type: "not_a_real_type", sessionId: "s2", ts: 2 },
    ];

    const res = await app.request(postJson("/test/inject", events));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; accepted: number };
    expect(body.ok).toBe(false);
    expect(body.accepted).toBe(0);
    expect(forwarded).toHaveLength(0);
  });

  it("testMode=true で配列でない body は 400 を返す", async () => {
    const { app, forwarded } = makeServer({ testMode: true });

    const res = await app.request(postJson("/test/inject", { not: "an array" }));

    expect(res.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
});

describe("GET /health", () => {
  it("pid / testMode / version / port を返す", async () => {
    const { app } = makeServer({ testMode: true, version: "1.2.3", getPort: () => 4100 });

    const res = await app.request("http://localhost/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      version: "1.2.3",
      testMode: true,
      pid: process.pid,
      port: 4100,
    });
  });
});
