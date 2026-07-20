import { describe, expect, it, vi } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { createForwarder } from "./forward.js";

const EVENT: OfficeEvent = {
  type: "session_start",
  sessionId: "s1",
  ts: 1_700_000_000_000,
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
});
