import { toolToState } from "./mapping";
import type { CharacterState, OfficeEvent } from "@ai-office/protocol";

/**
 * `PreToolUse(Task)` イベント 1 件分のスナップショット（M1-4b）。
 * subagent は独立した session_id を持たないため（設計メモ rev.3）、その帰属
 * （org/dept/role）と `subagentType` は親セッションの Task イベントに載る。
 * `subagent_stop` に task id が無く厳密な対応付けができないため、push/pop は
 * LIFO（後入れ先出し）の決定的規則で管理する。
 */
export interface SubagentEntry {
  subagentType?: string;
  org?: string;
  dept?: string;
  role?: string;
}

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
  /**
   * 帰属推定（relay の attributor が付与、FR-4）。M1-3 で追加。イベントに
   * 帰属が付いていない場合でも消さない（toolName と同じパススルー方針）。
   * セッション途中で帰属が消えないよう、後着イベントに帰属が無ければ既存の
   * 値を保持する（新しい値が来た場合のみ上書き）。
   *
   * 【M1-4b: Task イベントは対象外】`toolName === "Task"` の pre_tool/post_tool
   * イベントは「呼び出された subagent 自身の帰属」を運ぶ（規則 3）ため、この
   * org/dept/role には適用しない（適用すると親の帰属が subagent の帰属で
   * 上書きされてしまう。旧実装のバグ・rev.3 で修正）。代わりに `activeSubagents`
   * へ push する。
   */
  org?: string;
  dept?: string;
  role?: string;
  /** 現在進行中の Task（subagent 呼び出し）のスタック。LIFO で push/pop する。 */
  activeSubagents: SubagentEntry[];
  /**
   * このセッションが着手している作業依頼の本文（ADR-007 二層モデル・ローカル
   * 配信専用チャンネル。(b)-1）。`user_prompt`（トップレベルのユーザー依頼）と
   * `pre_tool`（Task 呼び出しの依頼文）から populate される。org/dept/role と
   * 同じ「消さない」パススルー方針: 後続イベントが requestText を運ばない場合は
   * 既存の値を保持する（新しい値が来た場合のみ上書き）。
   *
   * 【本サイクルのスコープ】session 単位で保持する（精密な subagent 個別割当は
   * (b)-2 以降）。relay 側で NFR-4 スコープが厳守されている（依頼文キーのみ）
   * ことを前提に、ここでは受け取った値をそのまま保持するだけで良い。
   */
  requestText?: string;
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
 * イベントに実際に含まれる帰属フィールドのみを抜き出す（キー自体を省略する
 * ことで、upsert 側のデフォルト値＝既存の帰属を上書きしないようにする）。
 */
function attributionPatch(ev: OfficeEvent): Pick<SessionCharacter, "org" | "dept" | "role"> {
  const patch: Pick<SessionCharacter, "org" | "dept" | "role"> = {};
  if (ev.org !== undefined) {
    patch.org = ev.org;
  }
  if (ev.dept !== undefined) {
    patch.dept = ev.dept;
  }
  if (ev.role !== undefined) {
    patch.role = ev.role;
  }
  return patch;
}

/**
 * `PreToolUse(Task)` イベントから、push すべき `SubagentEntry` を作る
 * （そのイベントの org/dept/role/subagentType は subagent 自身の帰属）。
 */
function taskEntry(ev: OfficeEvent): SubagentEntry {
  return { subagentType: ev.subagentType, org: ev.org, dept: ev.dept, role: ev.role };
}

/**
 * イベントに requestText が乗っている場合のみパッチを返す（キー自体を省略
 * することで、upsert 側のデフォルト値＝既存の requestText を上書きしない。
 * attributionPatch と同じパターン。ADR-007 (b)-1）。
 */
function requestTextPatch(ev: OfficeEvent): Pick<SessionCharacter, "requestText"> {
  return ev.requestText !== undefined ? { requestText: ev.requestText } : {};
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
        this.upsert(ev.sessionId, { state: "idle", lastTs: ev.ts, lastSeq: ev.seq, ...attributionPatch(ev) });
        break;
      }
      case "pre_tool": {
        const isTask = ev.toolName === "Task";
        this.upsert(ev.sessionId, {
          state: toolToState(ev.toolName),
          toolName: ev.toolName,
          lastTs: ev.ts,
          lastSeq: ev.seq,
          // Task イベントは subagent 自身の帰属を運ぶため、親セッションの
          // org/dept/role へは適用しない（クラスコメント参照）。代わりに
          // activeSubagents へ push する。
          ...(isTask ? { activeSubagents: [...(existing?.activeSubagents ?? []), taskEntry(ev)] } : attributionPatch(ev)),
          // pre_tool は toolName を問わず requestText を運びうる（relay は Task の
          // tool_input.prompt のみを載せるため、実際には Task に限られるが、
          // ここでは「今このセッションが着手している依頼」として一律に適用する。
          ...requestTextPatch(ev),
        });
        break;
      }
      case "post_tool": {
        const isTask = ev.toolName === "Task";
        this.upsert(ev.sessionId, {
          state: "thinking",
          lastTs: ev.ts,
          lastSeq: ev.seq,
          // post_tool(Task) も subagent 自身の帰属を運ぶため同様に適用しない
          // （rev.2 は pre_tool のみの半修正だった。rev.3 で post_tool も対象化）。
          ...(isTask ? {} : attributionPatch(ev)),
        });
        break;
      }
      case "user_prompt": {
        this.upsert(ev.sessionId, {
          state: "thinking",
          lastTs: ev.ts,
          lastSeq: ev.seq,
          ...attributionPatch(ev),
          ...requestTextPatch(ev),
        });
        break;
      }
      case "notification": {
        this.upsert(ev.sessionId, { state: "waiting", lastTs: ev.ts, lastSeq: ev.seq, ...attributionPatch(ev) });
        break;
      }
      case "stop": {
        this.upsert(ev.sessionId, { state: "done", lastTs: ev.ts, lastSeq: ev.seq, ...attributionPatch(ev) });
        break;
      }
      case "subagent_stop": {
        // task id が無いため厳密な対応付けはできない。後入れ先出し（LIFO）で
        // 直近に push された 1 件を pop する決定的規則（クラスコメント参照）。
        this.upsert(ev.sessionId, {
          state: "done",
          lastTs: ev.ts,
          lastSeq: ev.seq,
          activeSubagents: (existing?.activeSubagents ?? []).slice(0, -1),
          ...attributionPatch(ev),
        });
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
    patch: {
      state: CharacterState;
      toolName?: string;
      lastTs: number;
      lastSeq?: number;
      org?: string;
      dept?: string;
      role?: string;
      activeSubagents?: SubagentEntry[];
      requestText?: string;
    },
  ): void {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      sessionId,
      toolName: existing?.toolName,
      org: existing?.org,
      dept: existing?.dept,
      role: existing?.role,
      activeSubagents: existing?.activeSubagents ?? [],
      requestText: existing?.requestText,
      ...patch,
    });
  }

  private notify(): void {
    for (const cb of this.listeners) {
      cb();
    }
  }
}
