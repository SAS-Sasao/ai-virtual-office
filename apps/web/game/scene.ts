// キャラクターの実行時状態機械（M1-4a）。
//
// OfficeState（office-state.ts・変更禁止）のセッション集合を入力に、roster（常駐
// キャラ）の claim / visitor の spawn・退場・歩行を管理する。tick 駆動・全入力注入
// （Date.now() を呼ばない）。fast-mode（e2e）では歩行を即時完了させる。
//
// 【既知のスコープ外】subagent（Task で spawn されたセッション）を会議室へ優先的に
// 歩かせる要件（設計メモ item 3）は、office-state.ts の SessionCharacter が
// `subagentType` を保持しないため本サイクルでは実装しない（office-state.ts は本サイクル
// 変更禁止）。subagent セッションは role/dept の帰属が roster と衝突するか、帰属自体が
// 無いことが多く、その場合は下記の「claim できないセッションは visitor」ルートに自然に
// 合流する。真の会議室ルーティングは office-state 側で subagentType を保持できるように
// なった時点（M1-4b 以降）の追従課題とする。
import type { Character, CharacterState } from "@ai-office/protocol";
import type { OfficeState, OfficeSnapshot, SessionCharacter } from "./office-state";
import type { RuntimeFloor, RuntimeLayout } from "./layout-runtime";
import { roomInteriorAnchor } from "./layout-runtime";
import { findPath, type Tile } from "./pathfinding";
import type { SpriteDirection } from "./sprites";

/** 1 タイルの移動に要する tick 数（設計メモ: 「1 タイル/2tick」）。 */
export const TICKS_PER_TILE = 2;

export type RuntimeCharacterKind = "roster" | "visitor";

export interface RuntimeCharacter {
  /** roster: Character.id / visitor: sessionId。 */
  id: string;
  kind: RuntimeCharacterKind;
  org: string;
  /** 帰属不明な visitor では "" になりうる。 */
  dept: string;
  /** 帰属不明な visitor では "" になりうる。 */
  role: string;
  name?: string;
  sessionId: string | null;
  state: CharacterState;
  toolName?: string;
  x: number;
  y: number;
  direction: SpriteDirection;
  /** 未消化の残り経路（現在地は含まない）。歩行中でなければ null。 */
  path: Tile[] | null;
  progressTicks: number;
  onArriveState: CharacterState | null;
  despawnOnArrive: boolean;
}

export interface SceneOptions {
  /** ?e2e=1 相当。true の場合、歩行を即時完了させる（NFR-8）。 */
  fastMode?: boolean;
}

function directionBetween(from: Tile, to: Tile): SpriteDirection {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? "right" : "left";
  }
  if (dy !== 0) {
    return dy > 0 ? "down" : "up";
  }
  return "down";
}

export class Scene {
  private readonly runtimeLayout: RuntimeLayout;
  private readonly fastMode: boolean;
  private readonly charactersById = new Map<string, RuntimeCharacter>();
  private readonly claimedSessionByCharacterId = new Map<string, string>();
  private readonly visitorsBySessionId = new Map<string, RuntimeCharacter>();
  private readonly unsubscribe: () => void;
  private clock = 0;
  private lastAdvanceTick: number | null = null;

  constructor(
    runtimeLayout: RuntimeLayout,
    roster: readonly Character[],
    officeState: OfficeState,
    options: SceneOptions = {},
  ) {
    this.runtimeLayout = runtimeLayout;
    this.fastMode = options.fastMode ?? false;

    for (const character of roster) {
      const floor = this.findFloor(character.org);
      const desk = floor?.deskByCharacterId.get(character.id) ?? floor?.entrance ?? { x: 0, y: 0 };
      this.charactersById.set(character.id, {
        id: character.id,
        kind: "roster",
        org: character.org,
        dept: character.dept,
        role: character.role,
        name: character.name,
        sessionId: null,
        state: "idle",
        x: desk.x,
        y: desk.y,
        direction: "down",
        path: null,
        progressTicks: 0,
        onArriveState: null,
        despawnOnArrive: false,
      });
    }

    // office-state.ts は変更しない。scene がその変更通知を subscribe で消費する側。
    this.syncFromOffice(officeState.getSnapshot());
    this.unsubscribe = officeState.subscribe(() => this.syncFromOffice(officeState.getSnapshot()));
  }

  dispose(): void {
    this.unsubscribe();
  }

  isFastMode(): boolean {
    return this.fastMode;
  }

  getClock(): number {
    return this.clock;
  }

  getRuntimeCharacters(): RuntimeCharacter[] {
    return [...this.charactersById.values(), ...this.visitorsBySessionId.values()];
  }

  /** walk/leave 状態のキャラが 0 かつ未消化の歩行パスが 0 か（waitForIdle の定義）。 */
  isIdle(): boolean {
    return this.getRuntimeCharacters().every(
      (c) => c.state !== "walk" && c.state !== "leave" && (!c.path || c.path.length === 0),
    );
  }

  /**
   * OfficeState のスナップショットと突き合わせて claim / visitor / leave を更新する。
   * 通常は subscribe 経由で自動的に呼ばれるが、テストからの明示呼び出しにも対応する。
   */
  syncFromOffice(snapshot: OfficeSnapshot): void {
    const activeSessionIds = new Set(snapshot.sessions.map((s) => s.sessionId));

    for (const [characterId, sessionId] of [...this.claimedSessionByCharacterId]) {
      if (!activeSessionIds.has(sessionId)) {
        this.releaseClaim(characterId);
      }
    }

    for (const [sessionId, visitor] of [...this.visitorsBySessionId]) {
      if (!activeSessionIds.has(sessionId) && !visitor.despawnOnArrive) {
        this.startVisitorLeave(visitor);
      }
    }

    for (const session of snapshot.sessions) {
      this.reconcileSession(session);
    }
  }

  /** tick を進め、歩行中のキャラを 1 タイル/2tick のペースで移動させる。 */
  advance(nowTick: number): void {
    const delta = this.lastAdvanceTick === null ? 0 : Math.max(0, nowTick - this.lastAdvanceTick);
    this.lastAdvanceTick = nowTick;
    this.clock = nowTick;

    if (this.fastMode || delta === 0) return;

    for (const character of this.getRuntimeCharacters()) {
      if (!character.path || character.path.length === 0) continue;
      character.progressTicks += delta;
      while (character.path.length > 0 && character.progressTicks >= TICKS_PER_TILE) {
        character.progressTicks -= TICKS_PER_TILE;
        const next = character.path.shift()!;
        character.direction = directionBetween({ x: character.x, y: character.y }, next);
        character.x = next.x;
        character.y = next.y;
      }
      if (character.path.length === 0) {
        this.arrive(character);
      }
    }
  }

  private findFloor(org: string): RuntimeFloor | undefined {
    return this.runtimeLayout.floors.find((f) => f.floor.org === org);
  }

  private reconcileSession(session: SessionCharacter): void {
    const claimable = this.findClaimableCharacter(session);
    if (claimable) {
      this.applyClaim(claimable, session);
      return;
    }
    this.applyVisitor(session);
  }

  private findClaimableCharacter(session: SessionCharacter): RuntimeCharacter | undefined {
    // すでにこのセッションが claim 済みなら、その roster キャラを継続して返す。
    for (const [characterId, sessionId] of this.claimedSessionByCharacterId) {
      if (sessionId === session.sessionId) {
        return this.charactersById.get(characterId);
      }
    }

    if (!session.role || !session.dept || !session.org) return undefined;

    const candidate = [...this.charactersById.values()].find(
      (c) => c.kind === "roster" && c.org === session.org && c.dept === session.dept && c.role === session.role,
    );
    if (!candidate) return undefined;

    const existingClaim = this.claimedSessionByCharacterId.get(candidate.id);
    if (existingClaim && existingClaim !== session.sessionId) {
      // 別のまだアクティブなセッションに claim 済み: このセッションは visitor 扱い。
      return undefined;
    }
    return candidate;
  }

  private applyClaim(character: RuntimeCharacter, session: SessionCharacter): void {
    // 帰属が後着イベントで初めて解決し、それまで visitor として歩行/待機していた
    // セッションが claim に切り替わるケースの後始末。同一 sessionId の亡霊 visitor
    // が残ると getRuntimeCharacters() に重複表示されてしまうため、claim を反映する
    // 前に必ず visitor 側のエントリを消す。
    this.visitorsBySessionId.delete(session.sessionId);

    this.claimedSessionByCharacterId.set(character.id, session.sessionId);
    character.sessionId = session.sessionId;
    character.state = session.state;
    character.toolName = session.toolName;
    // roster は常に自席にいるため、claim は歩行を伴わない（設計メモ: 「自席で表現」）。
  }

  private releaseClaim(characterId: string): void {
    this.claimedSessionByCharacterId.delete(characterId);
    const character = this.charactersById.get(characterId);
    if (!character) return;
    character.sessionId = null;
    character.state = "idle";
    character.toolName = undefined;
    // roster はそもそも自席から離れていないため、"自席へ戻る" は既に成立している。
  }

  private applyVisitor(session: SessionCharacter): void {
    const floor = this.findFloor(session.org ?? "");
    const existing = this.visitorsBySessionId.get(session.sessionId);

    if (!existing) {
      const entrance = floor?.entrance ?? { x: 0, y: 0 };
      const visitor: RuntimeCharacter = {
        id: session.sessionId,
        kind: "visitor",
        org: session.org ?? "",
        dept: session.dept ?? "",
        role: session.role ?? "",
        sessionId: session.sessionId,
        state: "walk",
        toolName: session.toolName,
        x: entrance.x,
        y: entrance.y,
        direction: "down",
        path: null,
        progressTicks: 0,
        onArriveState: session.state,
        despawnOnArrive: false,
      };
      this.visitorsBySessionId.set(session.sessionId, visitor);
      this.startWalk(visitor, floor, this.resolveVisitorDestination(floor), "walk");
      return;
    }

    existing.dept = session.dept ?? existing.dept;
    existing.role = session.role ?? existing.role;
    existing.toolName = session.toolName;
    if (!existing.path || existing.path.length === 0) {
      existing.state = session.state;
    } else {
      existing.onArriveState = session.state;
    }
  }

  private resolveVisitorDestination(floor: RuntimeFloor | undefined): Tile {
    if (!floor) return { x: 0, y: 0 };
    if (floor.receptionRoom) return roomInteriorAnchor(floor.receptionRoom);
    return floor.entrance; // 受付部屋が無ければ入口付近に留まる
  }

  private startVisitorLeave(visitor: RuntimeCharacter): void {
    const floor = this.findFloor(visitor.org);
    visitor.despawnOnArrive = true;
    visitor.onArriveState = null;
    this.startWalk(visitor, floor, floor?.entrance ?? { x: visitor.x, y: visitor.y }, "leave");
  }

  private startWalk(
    character: RuntimeCharacter,
    floor: RuntimeFloor | undefined,
    destination: Tile,
    movingState: CharacterState,
  ): void {
    character.state = movingState;
    character.path = null;
    character.progressTicks = 0;

    if (!floor) {
      this.arrive(character);
      return;
    }

    const path = findPath(floor.walkGrid, { x: character.x, y: character.y }, destination);
    if (!path || path.length <= 1) {
      // 既に目的地にいる、または到達不能（pathfinding の契約どおり現在地に留まる）。
      this.arrive(character);
      return;
    }

    const remaining = path.slice(1);
    if (this.fastMode) {
      const last = remaining[remaining.length - 1];
      const prev = remaining.length > 1 ? remaining[remaining.length - 2] : { x: character.x, y: character.y };
      character.direction = directionBetween(prev, last);
      character.x = last.x;
      character.y = last.y;
      this.arrive(character);
      return;
    }

    character.path = remaining;
  }

  private arrive(character: RuntimeCharacter): void {
    character.path = null;
    character.progressTicks = 0;
    if (character.despawnOnArrive) {
      this.removeCharacter(character);
      return;
    }
    character.state = character.onArriveState ?? "idle";
    character.onArriveState = null;
  }

  private removeCharacter(character: RuntimeCharacter): void {
    if (character.kind === "visitor" && character.sessionId) {
      this.visitorsBySessionId.delete(character.sessionId);
    }
  }
}
