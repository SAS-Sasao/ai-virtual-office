import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { EVENT_LOG_CAPACITY, EventLogBuffer, formatEventLogLine } from "./event-log";

function ev(partial: Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">): OfficeEvent {
  return partial;
}

describe("EventLogBuffer (M1-4b: イベントログのクライアント側リングバッファ)", () => {
  it("returns items newest-first", () => {
    const buffer = new EventLogBuffer();
    buffer.push(ev({ type: "session_start", sessionId: "s1", ts: 1 }));
    buffer.push(ev({ type: "pre_tool", sessionId: "s1", ts: 2 }));

    expect(buffer.getItems().map((e) => e.ts)).toEqual([2, 1]);
  });

  it("caps at the default capacity (7), evicting the oldest entries", () => {
    const buffer = new EventLogBuffer();
    expect(EVENT_LOG_CAPACITY).toBe(7);

    for (let i = 1; i <= 10; i += 1) {
      buffer.push(ev({ type: "pre_tool", sessionId: "s1", ts: i }));
    }

    const items = buffer.getItems();
    expect(items).toHaveLength(7);
    expect(items.map((e) => e.ts)).toEqual([10, 9, 8, 7, 6, 5, 4]);
  });

  it("honors a custom capacity", () => {
    const buffer = new EventLogBuffer(2);
    buffer.push(ev({ type: "pre_tool", sessionId: "s1", ts: 1 }));
    buffer.push(ev({ type: "pre_tool", sessionId: "s1", ts: 2 }));
    buffer.push(ev({ type: "pre_tool", sessionId: "s1", ts: 3 }));

    expect(buffer.getItems().map((e) => e.ts)).toEqual([3, 2]);
  });

  it("starts empty", () => {
    expect(new EventLogBuffer().getItems()).toEqual([]);
  });
});

describe("formatEventLogLine (M1-4b: 「時刻 + type + sessionId 短縮」の1行整形)", () => {
  it("renders a deterministic UTC HH:MM:SS time, the event type, and the shortened sessionId", () => {
    // 2024-01-01T03:04:05.000Z
    const line = formatEventLogLine(ev({ type: "notification", sessionId: "session-abcdef1234567890", ts: Date.UTC(2024, 0, 1, 3, 4, 5) }));
    expect(line).toBe("03:04:05 notification session-");
  });

  it("is stable across repeated calls with the same injected ts (no wall-clock dependency)", () => {
    const event = ev({ type: "stop", sessionId: "s1", ts: 123_456_789 });
    expect(formatEventLogLine(event)).toBe(formatEventLogLine(event));
  });
});
