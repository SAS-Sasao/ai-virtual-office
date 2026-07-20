import { toolToState } from "./mapping";
import type { CharacterState, OfficeEvent } from "@ai-office/protocol";

export interface SessionCharacter {
  sessionId: string;
  state: CharacterState;
  toolName?: string;
  lastTs: number;
  /**
   * 直近に適用したイベントの seq。適用時に seq を持たないイベントだった
   * 場合は undefined になる（順序防御の watermark。OrderKey 参照）。
   */
  lastSeq?: number;
}

export interface OfficeSnapshot {
  sessions: SessionCharacter[];
}

export const PRUNE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * seq/ts による順序比較用のキー。protocol の順序規約（events.ts）どおり、
 * 両者が seq を持つ場合のみ seq で比較し、どちらかが欠けている場合は ts で
 * 比較する。
 */
interface OrderKey {
  seq?: number;
  ts: number;
}

/**
 * a が b より古ければ負、新しければ正、同一時点なら 0 を返す。
 */
function compareOrder(a: OrderKey, b: OrderKey): number {
  if (a.seq !== undefined && b.seq !== undefined) {
    return a.seq - b.seq;
  }
  return a.ts - b.ts;
}

/**
 * オフィスの内部モデル（キャラクター状態）を保持する命令的クラス。
 * requestAnimationFrame ループ（renderer 側）から駆動される想定であり、
 * React state には一切乗らない。時刻はすべて呼び出し側から注入される値
 * （OfficeEvent.ts / prune(now)）のみを用い、クラス内部で Date.now() を
 * 呼び出さない（テストの決定論性を保つため）。
 */
export class OfficeState {
  private sessions = new Map<string, SessionCharacter>();
  /**
   * 終了済み（session_end 受信済み）sessionId の watermark。getSnapshot には
   * 含めない（描画対象から外す）。これより古い/同値のイベントは破棄し、
   * これより新しいイベントが来た場合のみセッションを復活させる。
   */
  private tombstones = new Map<string, OrderKey>();
  private listeners = new Set<() => void>();

  applyEvent(ev: OfficeEvent): void {
    const tombstone = this.tombstones.get(ev.sessionId);
    if (tombstone) {
      if (compareOrder(ev, tombstone) <= 0) {
        // tombstone の watermark 以下（同値含む）は破棄し、復活させない。
        return;
      }
      // tombstone より新しいイベント: セッション再開の正当なケースとして復活させる。
      this.tombstones.delete(ev.sessionId);
    }

    const existing = this.sessions.get(ev.sessionId);
    if (existing && compareOrder(ev, { seq: existing.lastSeq, ts: existing.lastTs }) < 0) {
      // 保持中の状態より古いイベントは破棄する（再送バッファによる新→旧到着の防御）。
      return;
    }

    switch (ev.type) {
      case "session_end": {
        this.tombstones.set(ev.sessionId, { seq: ev.seq, ts: ev.ts });
        if (existing) {
          this.sessions.delete(ev.sessionId);
          this.notify();
        }
        return;
      }
      case "session_start": {
        this.upsert(ev.sessionId, { state: "idle", lastTs: ev.ts, lastSeq: ev.seq });
        break;
      }
      case "pre_tool": {
        this.upsert(ev.sessionId, {
          state: toolToState(ev.toolName),
          toolName: ev.toolName,
          lastTs: ev.ts,
          lastSeq: ev.seq,
        });
        break;
      }
      case "post_tool": {
        this.upsert(ev.sessionId, { state: "thinking", lastTs: ev.ts, lastSeq: ev.seq });
        break;
      }
      case "user_prompt": {
        this.upsert(ev.sessionId, { state: "thinking", lastTs: ev.ts, lastSeq: ev.seq });
        break;
      }
      case "notification": {
        this.upsert(ev.sessionId, { state: "waiting", lastTs: ev.ts, lastSeq: ev.seq });
        break;
      }
      case "stop":
      case "subagent_stop": {
        this.upsert(ev.sessionId, { state: "done", lastTs: ev.ts, lastSeq: ev.seq });
        break;
      }
      default: {
        // 未知のイベント種別は無視するが、型を網羅していることをコンパイラに保証させる。
        const _exhaustive: never = ev.type;
        void _exhaustive;
        return;
      }
    }

    this.notify();
  }

  /**
   * now - lastTs が 10 分を超えるセッションを削除する。tombstone も同じ
   * 期限で除去する（除去は描画対象の変化を伴わないため notify しない）。
   * 時刻は必ず引数として注入すること（クラス内で Date.now() を呼ばない）。
   */
  prune(now: number): void {
    let changed = false;
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastTs > PRUNE_TIMEOUT_MS) {
        this.sessions.delete(sessionId);
        changed = true;
      }
    }
    for (const [sessionId, tombstone] of this.tombstones) {
      if (now - tombstone.ts > PRUNE_TIMEOUT_MS) {
        this.tombstones.delete(sessionId);
      }
    }
    if (changed) {
      this.notify();
    }
  }

  getSnapshot(): OfficeSnapshot {
    return { sessions: Array.from(this.sessions.values()) };
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private upsert(
    sessionId: string,
    patch: { state: CharacterState; toolName?: string; lastTs: number; lastSeq?: number },
  ): void {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      sessionId,
      toolName: existing?.toolName,
      ...patch,
    });
  }

  private notify(): void {
    for (const cb of this.listeners) {
      cb();
    }
  }
}
