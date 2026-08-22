// キャラクターの実行時状態機械（M1-4a・M1-4b で subagent 対応を追加）。
//
// OfficeState（office-state.ts）のセッション集合を入力に、roster（常駐キャラ）の
// claim / visitor の spawn・退場・歩行、および subagent（Task で spawn された子
// キャラ）の spawn・退場・歩行を管理する。tick 駆動・全入力注入（Date.now() を
// 呼ばない）。fast-mode（e2e）では歩行を即時完了させる。
//
// 【subagent の扱い（M1-4b・設計メモ rev.3）】subagent は独立した session_id を
// 持たない。`office-state.ts` が「Task を呼んだ親セッション」の pre_tool イベントを
// `SessionCharacter.activeSubagents` へ push（subagent_stop で LIFO pop）してくれる
// ため、scene 側はその配列の増減を見て子キャラ（kind: "sub"）を spawn/despawn する
// （`reconcileSubagents`）。task id が無いため厳密な対応付けは不可能で、LIFO は
// 「決定的だが必ずしも正確ではない」規則である（既知の制約: 並行して異なる部署へ
// spawn した Task が複数ある場合、後から spawn した方の部署の子が先に退出して
// 見えることがある。件数は常に一致する）。
import type { Character, CharacterState } from "@ai-office/protocol";
import type { Floor, Room } from "@ai-office/protocol";
import type { OfficeState, OfficeSnapshot, SessionCharacter, SubagentEntry } from "./office-state";
import type { RuntimeFloor, RuntimeLayout } from "./layout-runtime";
import { roomInteriorAnchor } from "./layout-runtime";
import { findPath, type Tile } from "./pathfinding";
import type { SpriteDirection } from "./sprites";

/** 1 タイルの移動に要する tick 数（設計メモ: 「1 タイル/2tick」）。 */
export const TICKS_PER_TILE = 2;

export type RuntimeCharacterKind = "roster" | "visitor" | "sub";

export interface RuntimeCharacter {
  /** roster: Character.id / visitor: sessionId / sub: 親 sessionId + ":" + index。 */
  id: string;
  kind: RuntimeCharacterKind;
  org: string;
  /** 帰属不明な visitor/sub では "" になりうる。 */
  dept: string;
  /** 帰属不明な visitor/sub では "" になりうる。 */
  role: string;
  name?: string;
  /** claim 済み roster のみ Character.model を持つ。visitor/sub は不明のため undefined。 */
  model?: string;
  /** sub では常に親セッションの sessionId（subagent 自身は独立した session_id を持たない）。 */
  sessionId: string | null;
  state: CharacterState;
  toolName?: string;
  /** セッションが着手している作業依頼の本文の短縮表示元（ADR-007 (b)-2）。session
   *  単位（claim 済み roster / visitor）でのみ設定され、sub には設定しない。 */
  requestText?: string;
  x: number;
  y: number;
  direction: SpriteDirection;
  /** 未消化の残り経路（現在地は含まない）。歩行中でなければ null。 */
  path: Tile[] | null;
  progressTicks: number;
  onArriveState: CharacterState | null;
  despawnOnArrive: boolean;
  /** 非重複タイル割当で確保した部屋（"org:roomId"）。解放時に使う。 */
  reservedRoomKey?: string;
  /** 非重複タイル割当で確保したタイル。解放時に使う。 */
  reservedTile?: Tile;
  /** 直近に OfficeEvent 由来の更新を反映した scene tick（ホバーカードの経過表示用）。 */
  lastEventTick: number;
}

export interface HoveredCharacterDetail {
  id: string;
  kind: RuntimeCharacterKind;
  name?: string;
  role: string;
  dept: string;
  sessionId: string | null;
  state: CharacterState;
  toolName?: string;
  /** claim 済み roster のみ。visitor/sub は不明のため undefined（README 抽出仕様 2 からの唯一の逸脱点）。 */
  model?: string;
  /** RuntimeCharacter.requestText の透過（ADR-007 (b)-2）。sub は常に undefined。 */
  requestText?: string;
  elapsedTicks: number;
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

function tileKeyOf(tile: Tile): string {
  return `${tile.x},${tile.y}`;
}

function roomKeyOf(org: string, roomId: string): string {
  return `${org}:${roomId}`;
}

function deskTileKeys(floor: Floor): Set<string> {
  const keys = new Set<string>();
  for (const furniture of floor.furniture) {
    if (furniture.kind === "desk") {
      keys.add(tileKeyOf({ x: furniture.x, y: furniture.y }));
    }
  }
  return keys;
}

/**
 * 部屋内の visitor/sub 割当候補タイルを決定的順序で返す（非重複タイル割当）。
 * 先頭は `roomInteriorAnchor`（既存 AC-5 の「最初の 1 人は部屋の中央アンカーへ」
 * という挙動を保つため）、続けてそれ以外の内部タイルを行優先（y 昇順 → x 昇順）で
 * 並べる。デスクタイルは常に除外する。
 */
function roomTileCandidates(floor: Floor, room: Room): Tile[] {
  const deskKeys = deskTileKeys(floor);
  const anchor = roomInteriorAnchor(room);
  const seen = new Set<string>();
  const candidates: Tile[] = [];

  const anchorKey = tileKeyOf(anchor);
  if (!deskKeys.has(anchorKey)) {
    candidates.push(anchor);
    seen.add(anchorKey);
  }

  if (room.w >= 3 && room.h >= 3) {
    for (let y = room.y + 1; y <= room.y + room.h - 2; y += 1) {
      for (let x = room.x + 1; x <= room.x + room.w - 2; x += 1) {
        const key = tileKeyOf({ x, y });
        if (seen.has(key) || deskKeys.has(key)) continue;
        seen.add(key);
        candidates.push({ x, y });
      }
    }
  }

  return candidates;
}

export class Scene {
  private readonly runtimeLayout: RuntimeLayout;
  private readonly fastMode: boolean;
  private readonly charactersById = new Map<string, RuntimeCharacter>();
  private readonly claimedSessionByCharacterId = new Map<string, string>();
  private readonly visitorsBySessionId = new Map<string, RuntimeCharacter>();
  private readonly subsByKey = new Map<string, RuntimeCharacter>();
  /** 親 sessionId -> spawn 順に並んだ sub キャラの key スタック（LIFO の起点）。 */
  private readonly subStackBySession = new Map<string, string[]>();
  /**
   * 親 sessionId -> 次に発行する spawn key の連番（単調増加・pop しても巻き戻さない）。
   * key を `${sessionId}:${stack.length}` から作ると、shrink（subagent_stop）で
   * stack が縮んだ直後に同じ key が growth（次の Task）で再利用され、退場中の
   * sub を subsByKey 上で上書きしてしまう（office-qa M1-4b finding 1）。key の
   * 一意性をスタック長から切り離すために別カウンタを持つ。
   */
  private readonly subSpawnSeqBySession = new Map<string, number>();
  /** "org:roomId" -> 占有中タイルの集合（visitor/sub 共通の非重複タイル割当）。 */
  private readonly occupiedTilesByRoomKey = new Map<string, Set<string>>();
  private readonly unsubscribe: () => void;
  private clock = 0;
  private lastAdvanceTick: number | null = null;
  private currentFloorOrg: string | undefined;
  private focusedSessionId: string | null = null;
  private hoveredCharacter: HoveredCharacterDetail | null = null;
  /** OfficeState スナップショット由来の waiting セッション数（debug.ts の pendingNotifications の唯一のソース）。 */
  private waitingSessionCount = 0;

  constructor(
    runtimeLayout: RuntimeLayout,
    roster: readonly Character[],
    officeState: OfficeState,
    options: SceneOptions = {},
  ) {
    this.runtimeLayout = runtimeLayout;
    this.fastMode = options.fastMode ?? false;
    this.currentFloorOrg = runtimeLayout.floors[0]?.floor.org;

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
        model: character.model,
        sessionId: null,
        state: "idle",
        x: desk.x,
        y: desk.y,
        direction: "down",
        path: null,
        progressTicks: 0,
        onArriveState: null,
        despawnOnArrive: false,
        lastEventTick: 0,
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
    return [...this.charactersById.values(), ...this.visitorsBySessionId.values(), ...this.subsByKey.values()];
  }

  /** walk/leave 状態のキャラが 0 かつ未消化の歩行パスが 0 か（waitForIdle の定義）。 */
  isIdle(): boolean {
    return this.getRuntimeCharacters().every(
      (c) => c.state !== "walk" && c.state !== "leave" && (!c.path || c.path.length === 0),
    );
  }

  /** OfficeState の waiting セッション数（debug.ts の pendingNotifications はこれを一次ソースとする）。 */
  getWaitingSessionCount(): number {
    return this.waitingSessionCount;
  }

  /** 表示中フロア（ヒットテスト・フォーカスリングの対象を現在フロアに限定する）を切り替える。未知の org は no-op。 */
  setFloor(org: string): void {
    if (!this.findFloor(org)) return;
    this.currentFloorOrg = org;
  }

  getCurrentFloorOrg(): string | undefined {
    return this.currentFloorOrg;
  }

  /** セッション一覧クリック等からのフォーカス対象を設定する（null で解除）。renderer が z4 でリングを描く。 */
  focusSessionId(sessionId: string | null): void {
    this.focusedSessionId = sessionId;
  }

  getFocusedSessionId(): string | null {
    return this.focusedSessionId;
  }

  /**
   * ポインタ位置（canvas 座標系）を更新し、直下のキャラをヒットテストして
   * `hoveredCharacter` を更新する。null を渡すと解除する（mouseleave 相当）。
   * React state は経由しない（座標変換・ヒットテストは game 内で完結する）。
   */
  setPointer(canvasX: number | null, canvasY: number | null): void {
    if (canvasX === null || canvasY === null) {
      this.hoveredCharacter = null;
      return;
    }

    const floor = this.currentFloorOrg ? this.findFloor(this.currentFloorOrg) : undefined;
    if (!floor) {
      this.hoveredCharacter = null;
      return;
    }

    const tileSize = floor.floor.grid.tileSize;
    const hit = this.getRuntimeCharacters().find((c) => {
      if (c.org !== this.currentFloorOrg) return false;
      const left = c.x * tileSize;
      const top = c.y * tileSize;
      return canvasX >= left && canvasX < left + tileSize && canvasY >= top && canvasY < top + tileSize;
    });

    this.hoveredCharacter = hit ? this.buildHoverDetail(hit) : null;
  }

  getHoveredCharacter(): HoveredCharacterDetail | null {
    return this.hoveredCharacter;
  }

  /**
   * OfficeState のスナップショットと突き合わせて claim / visitor / sub / leave を更新する。
   * 通常は subscribe 経由で自動的に呼ばれるが、テストからの明示呼び出しにも対応する。
   */
  syncFromOffice(snapshot: OfficeSnapshot): void {
    const activeSessionIds = new Set(snapshot.sessions.map((s) => s.sessionId));
    this.waitingSessionCount = snapshot.sessions.filter((s) => s.state === "waiting").length;

    for (const [characterId, sessionId] of [...this.claimedSessionByCharacterId]) {
      if (!activeSessionIds.has(sessionId)) {
        this.releaseClaim(characterId);
      }
    }

    for (const [sessionId, visitor] of [...this.visitorsBySessionId]) {
      if (!activeSessionIds.has(sessionId) && !visitor.despawnOnArrive) {
        this.startLeave(visitor);
      }
    }

    // 親セッションが snapshot から消えた（session_end / prune）場合、紐づく子を
    // すべて despawn する（visitor 退出パターンの踏襲。FR-2「キャラ残留を防ぐ」）。
    for (const [sessionId, keys] of [...this.subStackBySession]) {
      if (activeSessionIds.has(sessionId)) continue;
      for (const key of keys) {
        const sub = this.subsByKey.get(key);
        if (sub && !sub.despawnOnArrive) {
          this.startLeave(sub);
        }
      }
      this.subStackBySession.delete(sessionId);
      this.subSpawnSeqBySession.delete(sessionId);
    }

    for (const session of snapshot.sessions) {
      this.reconcileSession(session);
      this.reconcileSubagents(session);
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

  private touch(character: RuntimeCharacter): void {
    character.lastEventTick = this.clock;
  }

  private buildHoverDetail(character: RuntimeCharacter): HoveredCharacterDetail {
    return {
      id: character.id,
      kind: character.kind,
      name: character.name,
      role: character.role,
      dept: character.dept,
      sessionId: character.sessionId,
      state: character.state,
      toolName: character.toolName,
      model: character.model,
      requestText: character.requestText,
      elapsedTicks: Math.max(0, this.clock - character.lastEventTick),
    };
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
    character.requestText = session.requestText;
    this.touch(character);
    // roster は常に自席にいるため、claim は歩行を伴わない（設計メモ: 「自席で表現」）。
  }

  private releaseClaim(characterId: string): void {
    this.claimedSessionByCharacterId.delete(characterId);
    const character = this.charactersById.get(characterId);
    if (!character) return;
    character.sessionId = null;
    character.state = "idle";
    character.toolName = undefined;
    character.requestText = undefined;
    this.touch(character);
    // roster はそもそも自席から離れていないため、"自席へ戻る" は既に成立している。
  }

  private applyVisitor(session: SessionCharacter): void {
    const floor = this.findFloor(session.org ?? "");
    const existing = this.visitorsBySessionId.get(session.sessionId);

    if (!existing) {
      const entrance = floor?.entrance ?? { x: 0, y: 0 };
      const destination = this.resolveDestination(floor, floor?.receptionRoom);
      const visitor: RuntimeCharacter = {
        id: session.sessionId,
        kind: "visitor",
        org: session.org ?? "",
        dept: session.dept ?? "",
        role: session.role ?? "",
        sessionId: session.sessionId,
        state: "walk",
        toolName: session.toolName,
        requestText: session.requestText,
        x: entrance.x,
        y: entrance.y,
        direction: "down",
        path: null,
        progressTicks: 0,
        onArriveState: session.state,
        despawnOnArrive: false,
        reservedRoomKey: destination.roomKey,
        reservedTile: destination.tile,
        lastEventTick: this.clock,
      };
      this.visitorsBySessionId.set(session.sessionId, visitor);
      this.startWalk(visitor, floor, destination.tile, "walk");
      return;
    }

    existing.dept = session.dept ?? existing.dept;
    existing.role = session.role ?? existing.role;
    existing.toolName = session.toolName;
    existing.requestText = session.requestText;
    this.touch(existing);
    if (!existing.path || existing.path.length === 0) {
      existing.state = session.state;
    } else {
      existing.onArriveState = session.state;
    }
  }

  /**
   * `session.activeSubagents`（office-state.ts が Task の pre_tool/subagent_stop から
   * push/pop する LIFO スタック）の増減を見て、子キャラの spawn/despawn を反映する。
   * `entries[index]` への対応付けは push 時点のスタック長（位置）で決定的に行うが、
   * key 自体はスタック長から独立した単調増加カウンタ（`subSpawnSeqBySession`）で
   * 発行する（同じ位置の key が退場中の別キャラを上書きしないため。理由は
   * `subSpawnSeqBySession` のコメント参照）。task id が無いため厳密な対応付けは
   * できない（ファイル冒頭コメント参照）。
   */
  private reconcileSubagents(session: SessionCharacter): void {
    const entries = session.activeSubagents ?? [];
    const stack = this.subStackBySession.get(session.sessionId) ?? [];

    while (stack.length < entries.length) {
      const index = stack.length;
      const seq = this.subSpawnSeqBySession.get(session.sessionId) ?? 0;
      this.subSpawnSeqBySession.set(session.sessionId, seq + 1);
      const key = `${session.sessionId}:${seq}`;
      this.spawnSub(key, entries[index], session.sessionId);
      stack.push(key);
    }

    while (stack.length > entries.length) {
      const key = stack.pop()!;
      const sub = this.subsByKey.get(key);
      if (sub && !sub.despawnOnArrive) {
        this.startLeave(sub);
      }
    }

    if (entries.length > 0 || this.subStackBySession.has(session.sessionId)) {
      this.subStackBySession.set(session.sessionId, stack);
    }
  }

  private spawnSub(key: string, entry: SubagentEntry, parentSessionId: string): void {
    const org = entry.org ?? "";
    const floor = this.findFloor(org);
    const deptRoom = floor?.floor.rooms.find((r) => r.id === entry.dept);
    const destination = this.resolveDestination(floor, deptRoom);
    const entrance = floor?.entrance ?? { x: 0, y: 0 };

    const sub: RuntimeCharacter = {
      id: key,
      kind: "sub",
      org,
      dept: entry.dept ?? "",
      role: entry.role ?? "",
      sessionId: parentSessionId,
      state: "walk",
      toolName: entry.subagentType,
      x: entrance.x,
      y: entrance.y,
      direction: "down",
      path: null,
      progressTicks: 0,
      // 到着後は固定で type（作業中表現。子の個別ツールイベントは存在しないため）。
      onArriveState: "type",
      despawnOnArrive: false,
      reservedRoomKey: destination.roomKey,
      reservedTile: destination.tile,
      lastEventTick: this.clock,
    };
    this.subsByKey.set(key, sub);
    this.startWalk(sub, floor, destination.tile, "walk");
  }

  /**
   * 部屋内の空きタイルを 1 つ確保する（非重複タイル割当）。room が無い、または
   * 満室なら undefined を返す（呼び出し側が受付 > 入口の順にフォールバックする）。
   */
  private allocateTile(floor: RuntimeFloor | undefined, room: Room | undefined): { tile: Tile; roomKey: string } | undefined {
    if (!floor || !room) return undefined;
    const roomKey = roomKeyOf(floor.floor.org, room.id);
    const occupied = this.getOccupiedSet(roomKey);
    for (const tile of roomTileCandidates(floor.floor, room)) {
      const key = tileKeyOf(tile);
      if (!occupied.has(key)) {
        occupied.add(key);
        return { tile, roomKey };
      }
    }
    return undefined; // 満室
  }

  /** primaryRoom → 受付 → フロア入口の順にフォールバックしながら目的地を確保する。 */
  private resolveDestination(
    floor: RuntimeFloor | undefined,
    primaryRoom: Room | undefined,
  ): { tile: Tile; roomKey?: string } {
    const primary = this.allocateTile(floor, primaryRoom);
    if (primary) return primary;

    if (floor?.receptionRoom && floor.receptionRoom !== primaryRoom) {
      const reception = this.allocateTile(floor, floor.receptionRoom);
      if (reception) return reception;
    }

    return { tile: floor?.entrance ?? { x: 0, y: 0 } };
  }

  private getOccupiedSet(roomKey: string): Set<string> {
    let set = this.occupiedTilesByRoomKey.get(roomKey);
    if (!set) {
      set = new Set();
      this.occupiedTilesByRoomKey.set(roomKey, set);
    }
    return set;
  }

  private releaseReservedTile(character: RuntimeCharacter): void {
    if (!character.reservedRoomKey || !character.reservedTile) return;
    const occupied = this.occupiedTilesByRoomKey.get(character.reservedRoomKey);
    occupied?.delete(tileKeyOf(character.reservedTile));
    character.reservedRoomKey = undefined;
    character.reservedTile = undefined;
  }

  /** visitor/sub 共通の退出開始（フロア入口へ歩き、到着で despawn）。 */
  private startLeave(character: RuntimeCharacter): void {
    const floor = this.findFloor(character.org);
    character.despawnOnArrive = true;
    character.onArriveState = null;
    this.startWalk(character, floor, floor?.entrance ?? { x: character.x, y: character.y }, "leave");
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
    this.releaseReservedTile(character);
    if (character.kind === "visitor" && character.sessionId) {
      this.visitorsBySessionId.delete(character.sessionId);
    } else if (character.kind === "sub") {
      this.subsByKey.delete(character.id);
    }
  }
}
