import { describe, expect, it, vi } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { createForwarder, stripCloudSensitive } from "./forward.js";

const EVENT: OfficeEvent = {
  type: "session_start",
  sessionId: "s1",
  ts: 1_700_000_000_000,
};

const EVENT_WITH_REQUEST_TEXT: OfficeEvent = {
  type: "user_prompt",
  sessionId: "s1",
  ts: 1_700_000_000_000,
  seq: 7,
  org: "domain-tech-collection",
  dept: "dept-engineering",
  role: "pipeline-dev",
  toolName: "Task",
  fileBase: "App.tsx",
  subagentType: "pipeline-dev",
  requestText: "秘密の依頼文",
};

describe("createForwarder", () => {
  it("POSTs the event as JSON to the configured URL and resolves true on 2xx", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(null, { status: 200 }),
    );
    const forward = createForwarder({ url: "http://localhost:3001/api/ingest", fetchImpl });

    await expect(forward(EVENT)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:3001/api/ingest");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(EVENT);
  });

  it("resolves false (does not throw) when fetch rejects (network error) — NFR-2 defense in depth", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        throw new Error("network down");
      },
    );
    const forward = createForwarder({ url: "http://localhost:3001/api/ingest", fetchImpl });

    await expect(forward(EVENT)).resolves.toBe(false);
  });

  it("resolves false (does not throw) when the response is a non-2xx status", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(null, { status: 500 }),
    );
    const forward = createForwarder({ url: "http://localhost:3001/api/ingest", fetchImpl });

    await expect(forward(EVENT)).resolves.toBe(false);
  });

  it("resolves true for any 2xx status, not just exactly 200", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(null, { status: 204 }),
    );
    const forward = createForwarder({ url: "http://localhost:3001/api/ingest", fetchImpl });

    await expect(forward(EVENT)).resolves.toBe(true);
  });

  it("defaults fetchImpl to globalThis.fetch when not provided", () => {
    const forward = createForwarder({ url: "http://localhost:3001/api/ingest" });
    expect(typeof forward).toBe("function");
  });

  it("POSTs the event including requestText to the local ingest endpoint (AC-7: local forwarder keeps requestText)", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(null, { status: 200 }),
    );
    const forward = createForwarder({ url: "http://localhost:3001/api/ingest", fetchImpl });

    await expect(forward(EVENT_WITH_REQUEST_TEXT)).resolves.toBe(true);

    const [, init] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody.requestText).toBe("秘密の依頼文");
    expect(sentBody).toEqual(EVENT_WITH_REQUEST_TEXT);
  });
});

describe("stripCloudSensitive", () => {
  it("removes requestText from the returned object (AC-6: cloud boundary strip)", () => {
    const stripped = stripCloudSensitive(EVENT_WITH_REQUEST_TEXT);

    expect(stripped).not.toHaveProperty("requestText");
    expect(JSON.stringify(stripped)).not.toContain("秘密の依頼文");
  });

  it("preserves non-sensitive fields (type/sessionId/ts/seq/org/dept/role/toolName/fileBase/subagentType)", () => {
    const stripped = stripCloudSensitive(EVENT_WITH_REQUEST_TEXT);

    expect(stripped).toEqual({
      type: "user_prompt",
      sessionId: "s1",
      ts: 1_700_000_000_000,
      seq: 7,
      org: "domain-tech-collection",
      dept: "dept-engineering",
      role: "pipeline-dev",
      toolName: "Task",
      fileBase: "App.tsx",
      subagentType: "pipeline-dev",
    });
  });

  it("does not mutate the original event (pure function)", () => {
    const original: OfficeEvent = { ...EVENT_WITH_REQUEST_TEXT };

    stripCloudSensitive(original);

    expect(original).toEqual(EVENT_WITH_REQUEST_TEXT);
    expect(original.requestText).toBe("秘密の依頼文");
  });

  it("is a no-op for events without requestText (returns an equivalent object)", () => {
    const stripped = stripCloudSensitive(EVENT);

    expect(stripped).toEqual(EVENT);
    expect(stripped).not.toHaveProperty("requestText");
  });
});
