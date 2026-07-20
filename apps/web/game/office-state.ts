import { toolToState } from "./mapping";
import type { CharacterState, OfficeEvent } from "./protocol";

export interface SessionCharacter {
  sessionId: string;
  state: CharacterState;
  toolName?: string;
  lastTs: number;
}

export interface OfficeSnapshot {
  sessions: SessionCharacter[];
}

const PRUNE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * オフィスの内部モデル（キャラクター状態）を保持する命令的クラス。
 * requestAnimationFrame ループ（renderer 側）から駆動される想定であり、
 * React state には一切乗らない。時刻はすべて呼び出し側から注入される値
 * （OfficeEvent.ts / prune(now)）のみを用い、クラス内部で Date.now() を
 * 呼び出さない（テストの決定論性を保つため）。
 */
export class OfficeState {
  private sessions = new Map<string, SessionCharacter>();
  private listeners = new Set<() => void>();

  applyEvent(ev: OfficeEvent): void {
    const existing = this.sessions.get(ev.sessionId);

    switch (ev.type) {
      case "session_end": {
        if (existing) {
          this.sessions.delete(ev.sessionId);
          this.notify();
        }
        return;
      }
      case "session_start": {
        this.upsert(ev.sessionId, { state: "idle", lastTs: ev.ts });
        break;
      }
      case "pre_tool": {
        this.upsert(ev.sessionId, {
          state: toolToState(ev.toolName),
          toolName: ev.toolName,
          lastTs: ev.ts,
        });
        break;
      }
      case "post_tool": {
        this.upsert(ev.sessionId, { state: "thinking", lastTs: ev.ts });
        break;
      }
      case "user_prompt": {
        this.upsert(ev.sessionId, { state: "thinking", lastTs: ev.ts });
        break;
      }
      case "notification": {
        this.upsert(ev.sessionId, { state: "waiting", lastTs: ev.ts });
        break;
      }
      case "stop":
      case "subagent_stop": {
        this.upsert(ev.sessionId, { state: "done", lastTs: ev.ts });
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
   * now - lastTs が 10 分を超えるセッションを削除する。
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
    patch: { state: CharacterState; toolName?: string; lastTs: number },
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
