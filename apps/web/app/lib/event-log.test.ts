import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { EVENT_LOG_CAPACITY, EVENT_LOG_SESSION_TRACK_LIMIT, EventLogBuffer, formatEventLogLine } from "./event-log";
import { buildNarrationText } from "./narration";

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

/**
 * バックエンド堅牢化サイクル2「修正D（eventlog-state-divergence の是正、
 * rev.2 log 層方式）」(AC-7/AC-8)。`push()` を per-session identity dedup 付き
 * boolean 返却へ拡張する。既存の push/getItems の assertion（上の describe）は
 * 変更しない（push が void を返すか boolean を返すかは呼び出し側で無視できる
 * ため、既存テストは無改修で green のまま）。
 */
describe("EventLogBuffer.push の identity dedup（AC-7: per-session dedup + boolean 返却）", () => {
  it("同一セッションの同一 identity（sessionId#seq）を2回 push すると2回目は false・件数は+1のみ", () => {
    const buffer = new EventLogBuffer();
    const first = ev({ type: "pre_tool", sessionId: "s1", ts: 1, seq: 5 });
    const duplicate = ev({ type: "pre_tool", sessionId: "s1", ts: 1, seq: 5 });

    expect(buffer.push(first)).toBe(true);
    expect(buffer.push(duplicate)).toBe(false);
    expect(buffer.getItems()).toHaveLength(1);
  });

  it("seq 欠落時は sessionId#ts#type を identity として使い、同一なら2回目は false", () => {
    const buffer = new EventLogBuffer();
    const first = ev({ type: "notification", sessionId: "s1", ts: 100 });
    const duplicate = ev({ type: "notification", sessionId: "s1", ts: 100 });

    expect(buffer.push(first)).toBe(true);
    expect(buffer.push(duplicate)).toBe(false);
    expect(buffer.getItems()).toHaveLength(1);
  });

  it("同一セッションでも identity が異なれば（seq が進めば）true を返し件数が加算される", () => {
    const buffer = new EventLogBuffer();
    expect(buffer.push(ev({ type: "pre_tool", sessionId: "s1", ts: 1, seq: 5 }))).toBe(true);
    expect(buffer.push(ev({ type: "post_tool", sessionId: "s1", ts: 2, seq: 6 }))).toBe(true);
    expect(buffer.getItems()).toHaveLength(2);
  });

  it("別セッションの同一 seq は互いに干渉せず、どちらも true になる", () => {
    const buffer = new EventLogBuffer();
    expect(buffer.push(ev({ type: "pre_tool", sessionId: "s1", ts: 1, seq: 1 }))).toBe(true);
    expect(buffer.push(ev({ type: "pre_tool", sessionId: "s2", ts: 1, seq: 1 }))).toBe(true);
    expect(buffer.getItems()).toHaveLength(2);
  });

  it("多数セッション（20+）を挟んでも各セッションの直近 identity 再送は evict 穴なく落ちる（Map<sessionId,identity> 方式）", () => {
    const buffer = new EventLogBuffer(100);
    const sessionA = ev({ type: "session_start", sessionId: "session-a", ts: 1, seq: 1 });
    expect(buffer.push(sessionA)).toBe(true);

    // 固定容量リング（旧実装）であれば session-a の直近 identity がここで
    // evict されてしまい、以後の再送が誤って true になっていた回帰を防ぐ。
    for (let i = 0; i < 25; i += 1) {
      buffer.push(ev({ type: "session_start", sessionId: `filler-${i}`, ts: 10 + i, seq: 1 }));
    }

    const sessionARestoreReplay = ev({ type: "session_start", sessionId: "session-a", ts: 1, seq: 1 });
    expect(buffer.push(sessionARestoreReplay)).toBe(false);
  });

  it("メモリ backstop: 追跡セッション数の上限を超えても例外を投げず、直近セッションの dedup は機能し続ける", () => {
    const buffer = new EventLogBuffer(10_000);

    for (let i = 0; i < EVENT_LOG_SESSION_TRACK_LIMIT + 5; i += 1) {
      expect(buffer.push(ev({ type: "session_start", sessionId: `overflow-s${i}`, ts: i, seq: 1 }))).toBe(true);
    }

    const lastSessionId = `overflow-s${EVENT_LOG_SESSION_TRACK_LIMIT + 4}`;
    const replay = ev({ type: "session_start", sessionId: lastSessionId, ts: EVENT_LOG_SESSION_TRACK_LIMIT + 4, seq: 1 });
    expect(buffer.push(replay)).toBe(false);
  });
});

describe("EventLogBuffer × restore 再送の二重記録防止（AC-8: ユーザー可視バグの回帰ガード）", () => {
  it("同一 restore 相当イベントを2回流しても getItems() は不変", () => {
    const buffer = new EventLogBuffer();
    const restored = ev({ type: "notification", sessionId: "s1", ts: 500, seq: 3 });

    buffer.push(restored);
    const afterFirst = buffer.getItems();

    const pushedAgain = buffer.push({ ...restored });
    const afterSecond = buffer.getItems();

    expect(pushedAgain).toBe(false);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("buildNarrationText(getItems()[0]) が restore 再送で再アナウンスされない（同一イベント再送で narration が変化しない）", () => {
    const buffer = new EventLogBuffer();
    const restored = ev({ type: "session_end", sessionId: "s1", ts: 500, seq: 3 });

    buffer.push(restored);
    const narrationBefore = buildNarrationText(buffer.getItems()[0] ?? null);

    buffer.push({ ...restored }); // 再接続による restore 再送を模す
    const narrationAfter = buildNarrationText(buffer.getItems()[0] ?? null);

    expect(narrationAfter).toBe(narrationBefore);
  });

  it("restore 再送の後に新しい live イベントが来れば、通常どおり記録・ナレーションが更新される", () => {
    const buffer = new EventLogBuffer();
    const restored = ev({ type: "session_start", sessionId: "s1", ts: 500, seq: 3 });
    buffer.push(restored);
    buffer.push({ ...restored }); // 再送（無視される）

    const newLiveEvent = ev({ type: "stop", sessionId: "s1", ts: 600, seq: 4 });
    expect(buffer.push(newLiveEvent)).toBe(true);
    expect(buffer.getItems()[0]).toEqual(newLiveEvent);
    expect(buildNarrationText(buffer.getItems()[0])).toContain("作業を完了しました");
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
