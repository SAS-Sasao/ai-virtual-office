import { beforeEach, describe, expect, it } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { createDb, type Db } from "./client";
import { events } from "./schema";
import { insertEvent, loadRecentSessions, pruneOlderThan } from "./events";

function makeEvent(overrides: Partial<OfficeEvent> = {}): OfficeEvent {
  return { type: "session_start", sessionId: "s1", ts: 1_700_000_000_000, ...overrides };
}

describe("db/events", () => {
  let db: Db;

  beforeEach(() => {
    // NFR-2 / 本番非破壊: 必ず :memory: のみを使い、~/.ai-office/events.db には
    // 一切触れない（createDb は raw sqlite ファイルを一切生成しない）。
    const created = createDb(":memory:");
    if (!created) {
      throw new Error("failed to create in-memory test db");
    }
    db = created;
  });

  describe("insertEvent", () => {
    it("saves an event and it can be read back with all fields intact", () => {
      const ev = makeEvent({
        type: "pre_tool",
        sessionId: "s1",
        toolName: "Edit",
        fileBase: "App.tsx",
        ts: 100,
        seq: 5,
      });

      insertEvent(db, ev);

      const rows = db.select().from(events).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "pre_tool",
        sessionId: "s1",
        toolName: "Edit",
        fileBase: "App.tsx",
        subagentType: null,
        ts: 100,
        seq: 5,
      });
      expect(typeof rows[0].receivedAt).toBe("number");
    });

    it("saves an event without seq (undefined) as a null column, without throwing", () => {
      const ev = makeEvent({ ts: 200 }); // no seq field on the OfficeEvent

      expect(() => insertEvent(db, ev)).not.toThrow();

      const rows = db.select().from(events).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].seq).toBeNull();
    });

    it("does not persist fields that are not part of OfficeEvent (NFR-4 regression guard)", () => {
      // events テーブルには OfficeEvent のフィールド以外の列が存在しないため、
      // 機微情報（プロンプト本文・cwd・URL 等）が保存される経路は構造的に無い
      // ことを、実際の行の列名だけで確認する。
      insertEvent(db, makeEvent());

      const rows = db.select().from(events).all();
      const columns = Object.keys(rows[0]).sort();
      expect(columns).toEqual(
        ["fileBase", "id", "receivedAt", "seq", "sessionId", "subagentType", "toolName", "ts", "type"].sort(),
      );
      for (const forbidden of ["prompt", "toolInput", "tool_input", "cwd", "transcriptPath", "command", "url"]) {
        expect(columns).not.toContain(forbidden);
      }
    });
  });

  describe("loadRecentSessions", () => {
    it("returns only the latest event per session (not a full replay)", () => {
      insertEvent(db, makeEvent({ sessionId: "s1", type: "session_start", ts: 100 }));
      insertEvent(db, makeEvent({ sessionId: "s1", type: "pre_tool", toolName: "Edit", ts: 200 }));
      insertEvent(db, makeEvent({ sessionId: "s1", type: "post_tool", toolName: "Edit", ts: 300 }));

      const restored = loadRecentSessions(db, 1_000, 10_000);

      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ sessionId: "s1", type: "post_tool", ts: 300 });
    });

    it("excludes sessions whose latest event is older than now - windowMs", () => {
      insertEvent(db, makeEvent({ sessionId: "old", ts: 0 }));
      insertEvent(db, makeEvent({ sessionId: "fresh", ts: 900 }));

      const restored = loadRecentSessions(db, 1_000, 500); // cutoff = 500

      expect(restored.map((e) => e.sessionId)).toEqual(["fresh"]);
    });

    it("returns one event per distinct session when multiple sessions are present", () => {
      insertEvent(db, makeEvent({ sessionId: "a", ts: 100 }));
      insertEvent(db, makeEvent({ sessionId: "b", ts: 200 }));
      insertEvent(db, makeEvent({ sessionId: "c", ts: 300 }));

      const restored = loadRecentSessions(db, 1_000, 10_000);

      expect(restored.map((e) => e.sessionId).sort()).toEqual(["a", "b", "c"]);
    });

    it("defaults windowMs to PRUNE_TIMEOUT_MS (10 min) when not provided", () => {
      insertEvent(db, makeEvent({ sessionId: "s1", ts: 0 }));

      // PRUNE_TIMEOUT_MS = 10 分。それより十分離れた now を渡すと除外される。
      const restored = loadRecentSessions(db, 20 * 60 * 1000);

      expect(restored).toHaveLength(0);
    });

    it("picks the row with the larger seq when two rows share the same ts inserted out of seq order (Phase 3 review medium finding)", () => {
      // N-2 で head-of-line を撤回した結果、ingest への逆順到着（seq が
      // 若い方が後から届く）は正常な入力形状になった。insert 順（id）ではなく
      // protocol の順序規約（両者が seq を持つときのみ seq 比較、欠ければ ts
      // 比較。apps/web/game/office-state.ts の compareOrder と同一規則）で
      // 「最新」を判定しなければならない。
      //
      // seq=11 を先に、seq=10 を後に insert する（同一 ts）。insert 順（id）
      // だけで見ると seq=10 の行が「後から入った」ので誤って選ばれてしまう
      // ことを、この行がまさに再現している。
      insertEvent(db, makeEvent({ sessionId: "s1", type: "pre_tool", toolName: "Edit", ts: 500, seq: 11 }));
      insertEvent(db, makeEvent({ sessionId: "s1", type: "post_tool", toolName: "Edit", ts: 500, seq: 10 }));

      const restored = loadRecentSessions(db, 1_000, 10_000);

      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ sessionId: "s1", seq: 11, type: "pre_tool" });
    });

    it("falls back to ts comparison when either candidate row lacks a seq, even if the other has one", () => {
      // 規約: 両者が seq を持つ場合のみ seq で比較する。片方でも欠けていれば
      // ts で比較する（seq を持つ方を無条件に優先しない）。
      insertEvent(db, makeEvent({ sessionId: "s1", ts: 100 })); // no seq
      insertEvent(db, makeEvent({ sessionId: "s1", ts: 50, seq: 999 })); // has seq, but older ts

      const restored = loadRecentSessions(db, 1_000, 10_000);

      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ sessionId: "s1", ts: 100 });
      expect(restored[0].seq).toBeUndefined();
    });

    it("compares by ts when neither candidate row has a seq", () => {
      insertEvent(db, makeEvent({ sessionId: "s1", ts: 100 }));
      insertEvent(db, makeEvent({ sessionId: "s1", ts: 50 }));

      const restored = loadRecentSessions(db, 1_000, 10_000);

      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ sessionId: "s1", ts: 100 });
    });

    // AC-7: サイクル2b（DB durability）design memo §C。再接続時の SSE emit
    // 増幅を抑えるため、fold 後（latest-per-session）の出力を最新 ts の
    // 新しい順に上位 maxSessions セッションだけへ切り詰める。切り詰め後の
    // 返却順は従来どおり ts 昇順。
    it("caps output to the most recent maxSessions sessions (by latest ts), still sorted ascending (AC-7)", () => {
      insertEvent(db, makeEvent({ sessionId: "oldest", ts: 100 }));
      insertEvent(db, makeEvent({ sessionId: "middle", ts: 200 }));
      insertEvent(db, makeEvent({ sessionId: "newest", ts: 300 }));

      const restored = loadRecentSessions(db, 1_000, 10_000, 2);

      expect(restored.map((e) => e.sessionId)).toEqual(["middle", "newest"]);
    });

    it("does not drop anything when the number of sessions is within maxSessions (AC-7 boundary)", () => {
      insertEvent(db, makeEvent({ sessionId: "a", ts: 100 }));
      insertEvent(db, makeEvent({ sessionId: "b", ts: 200 }));

      const restored = loadRecentSessions(db, 1_000, 10_000, 2);

      expect(restored.map((e) => e.sessionId)).toEqual(["a", "b"]);
    });

    // AC-8: maxSessions 既定 200 のもとで、既存の loadRecentSessions 系
    // テスト（本 describe 内の全ケース）が無改修 green であることが本来の
    // 回帰保証。ここでは「既定値を明示的に呼ばない場合でも 200 未満の
    // セッション数では何も削られない」ことをもう一段直接的に確認する。
    it("does not truncate anything when session count is well below the default maxSessions=200 (AC-8)", () => {
      for (let i = 0; i < 10; i++) {
        insertEvent(db, makeEvent({ sessionId: `s${i}`, ts: 100 + i }));
      }

      const restored = loadRecentSessions(db, 1_000, 10_000); // maxSessions omitted -> default 200

      expect(restored).toHaveLength(10);
      expect(restored.map((e) => e.ts)).toEqual([...restored.map((e) => e.ts)].sort((a, b) => a - b));
    });
  });

  describe("pruneOlderThan", () => {
    it("deletes only rows older than cutoffTs and returns the deleted count", () => {
      insertEvent(db, makeEvent({ sessionId: "old1", ts: 100 }));
      insertEvent(db, makeEvent({ sessionId: "old2", ts: 200 }));
      insertEvent(db, makeEvent({ sessionId: "fresh", ts: 900 }));

      const deleted = pruneOlderThan(db, 500);

      expect(deleted).toBe(2);
      const remaining = db.select().from(events).all();
      expect(remaining.map((r) => r.sessionId)).toEqual(["fresh"]);
    });

    it("returns 0 when nothing is old enough to delete", () => {
      insertEvent(db, makeEvent({ sessionId: "fresh", ts: 900 }));

      const deleted = pruneOlderThan(db, 100);

      expect(deleted).toBe(0);
    });
  });
});
