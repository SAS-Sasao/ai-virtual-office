import type { CharacterState } from "@ai-office/protocol";
import type { RuntimeFloor, RuntimeLayout } from "./layout-runtime";
import type { RuntimeCharacter } from "./scene";
import { Scene } from "./scene";
import {
  createGeneratedSpriteSheet,
  type CanvasFactory,
  type CharacterPalette,
  type DrawableCanvas,
  type SpriteDirection,
  type SpritePose,
  type SpriteSheet,
} from "./sprites";

// Canvas 2D レンダラー（M1-4a 全面改修）。
//
// レイヤー構成（ADR-002）: z0 backdrop（本サイクルは単色背景のみ。PNG 背景ロードは
// M2/ADR-004 の対象外として据え置き）→ z1 部屋（床材の status 塗り分け・壁・
// 名前プレート・standby 減光）→ z2 家具（デスク primitive）→ z3 キャラ
// （スプライトシート）→ z4 オーバーレイ（吹き出し・名前・waiting 明滅）。
//
// 性能（NFR-1）: z0〜z2 はフロアごとにオフスクリーンへ 1 回だけ描画し（AC-8）、
// 毎フレームは 1 回の drawImage（blit）+ z3/z4 のみを描く。フロア切替
// （setFloor）でまだキャッシュの無い org を初めて表示するときだけ再構築する。
//
// テスタビリティ: canvas 生成（floor レイヤー・スプライトアトラス）と
// requestAnimationFrame/cancelAnimationFrame はすべて呼び出し側から注入する
// （node テストは描画呼び出し記録スタブ + 手動 raf ポンプを使う）。

export interface RendererDeps {
  /** z1/z2 のフロアレイヤー・z3 のスプライトアトラス生成に使う offscreen canvas ファクトリ。 */
  canvasFactory: CanvasFactory;
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
}

export interface RendererHandle {
  stop(): void;
  setFloor(org: string): void;
}

const BACKGROUND_COLOR = "#0b0d18";
const BORDER_COLOR = "#2a3050";
const ROOM_FLOOR_ACTIVE = "#3b415f";
const ROOM_FLOOR_STANDBY = "#161a2c";
const NAME_PLATE_BG = "rgba(11,13,24,0.82)";
const TEXT_PRIMARY = "#e8eaf6";
const DESK_COLOR = "#20304a";

// 状態別の色（docs/design/ui/README.md 抽出仕様 2 の 8 状態そのまま）。
// walk/leave はモック未表現の移動由来の状態（Canvas 実装側の補完・README 注記のとおり）。
const STATE_COLORS: Record<CharacterState, string> = {
  idle: "#9aa0b8",
  type: "#7ef29a",
  read: "#6be5ff",
  terminal: "#c39bff",
  browsing: "#5aa2ff",
  thinking: "#9aa0b8",
  waiting: "#ffd166",
  done: "#ffffff",
  walk: "#9aa0b8",
  leave: "#6a7194",
};

const WAITING_BLINK_PERIOD_MS = 500;
const BOB_PERIOD_MS = 2600;
const BOB_AMPLITUDE_PX = 2;
const SPRITE_SIZE_PX = 24;

const TICK_DURATION_MS = 90;

function tickFromNow(now: number): number {
  return Math.floor(now / TICK_DURATION_MS);
}

// キャラごとの見た目を決定論的に割り当てるパレット候補
// （docs/design/ui/README.md 抽出仕様 1 のアクセントトークンを流用）。
const BODY_COLORS = ["#7ef29a", "#6be5ff", "#ffd166", "#5aa2ff", "#c39bff", "#ff9f6b"];
const HAIR_COLORS = ["#20304a", "#3a2c1c", "#1a1e36", "#2a3050"];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function paletteForCharacterId(id: string): CharacterPalette {
  const hash = hashString(id);
  return {
    body: BODY_COLORS[hash % BODY_COLORS.length],
    hair: HAIR_COLORS[Math.floor(hash / BODY_COLORS.length) % HAIR_COLORS.length],
  };
}

function poseFor(character: RuntimeCharacter, now: number, fastMode: boolean): SpritePose {
  if (character.state === "walk" || character.state === "leave") {
    if (fastMode) return "walk0";
    const phase = Math.floor(now / 220) % 2;
    return phase === 0 ? "walk0" : "walk1";
  }
  return "idle";
}

function buildFloorLayer(floor: RuntimeFloor["floor"], canvasFactory: CanvasFactory): DrawableCanvas {
  const width = floor.grid.cols * floor.grid.tileSize;
  const height = floor.grid.rows * floor.grid.tileSize;
  const canvas = canvasFactory(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context is not available for the floor layer");
  }

  const tileSize = floor.grid.tileSize;

  // z0: backdrop（本サイクルは単色のみ。PNG 背景ロードは対象外 = ADR-002/004）
  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, height);

  // z1: 部屋（床材の status 塗り分け・壁・名前プレート）
  for (const room of floor.rooms) {
    const x = room.x * tileSize;
    const y = room.y * tileSize;
    const w = room.w * tileSize;
    const h = room.h * tileSize;

    ctx.fillStyle = room.status === "active" ? ROOM_FLOOR_ACTIVE : ROOM_FLOOR_STANDBY;
    ctx.globalAlpha = room.status === "active" ? 1 : 0.6; // standby は減光
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = NAME_PLATE_BG;
    ctx.fillRect(x, y, Math.min(w, room.name.length * 8 + 8), 14);
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.fillText(room.name, x + 4, y + 10);
  }

  // z2: 家具（デスク primitive）
  for (const furniture of floor.furniture) {
    if (furniture.kind !== "desk") continue;
    const x = furniture.x * tileSize;
    const y = furniture.y * tileSize;
    ctx.fillStyle = DESK_COLOR;
    ctx.fillRect(x, y, tileSize, tileSize * 0.7);
    ctx.strokeStyle = BORDER_COLOR;
    ctx.strokeRect(x, y, tileSize, tileSize * 0.7);
  }

  return canvas;
}

/**
 * Canvas 2D への requestAnimationFrame 描画ループを開始する。
 * `scene` は tick 駆動で毎フレーム advance() され、`office-state.ts` の変更は
 * scene 自身が subscribe 経由で消費する（renderer は OfficeState を直接触らない）。
 */
export function startRenderer(
  canvas: HTMLCanvasElement,
  scene: Scene,
  runtimeLayout: RuntimeLayout,
  deps: RendererDeps,
): RendererHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context is not available");
  }

  const raf = deps.requestAnimationFrame ?? ((cb) => requestAnimationFrame(cb));
  const caf = deps.cancelAnimationFrame ?? ((id) => cancelAnimationFrame(id));

  const floorLayerCache = new Map<string, DrawableCanvas>();
  const spriteCache = new Map<string, SpriteSheet>();

  let currentOrg = runtimeLayout.floors[0]?.floor.org;
  let rafId: number | undefined;
  let stopped = false;

  const findFloor = (org: string | undefined): RuntimeFloor | undefined =>
    runtimeLayout.floors.find((f) => f.floor.org === org);

  const getOrBuildFloorLayer = (org: string | undefined): DrawableCanvas | undefined => {
    if (!org) return undefined;
    const cached = floorLayerCache.get(org);
    if (cached) return cached;
    const runtimeFloor = findFloor(org);
    if (!runtimeFloor) return undefined;
    const layer = buildFloorLayer(runtimeFloor.floor, deps.canvasFactory);
    floorLayerCache.set(org, layer);
    return layer;
  };

  const getOrBuildSpriteSheet = (character: RuntimeCharacter): SpriteSheet => {
    const cached = spriteCache.get(character.id);
    if (cached) return cached;
    const sheet = createGeneratedSpriteSheet(paletteForCharacterId(character.id), deps.canvasFactory);
    spriteCache.set(character.id, sheet);
    return sheet;
  };

  const draw = (now: number): void => {
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, width, height);

    const runtimeFloor = findFloor(currentOrg);
    const layer = getOrBuildFloorLayer(currentOrg);
    if (layer) {
      ctx.drawImage(layer as unknown as CanvasImageSource, 0, 0);
    }
    if (!runtimeFloor) return;

    const tileSize = runtimeFloor.floor.grid.tileSize;
    const fastMode = scene.isFastMode();

    for (const character of scene.getRuntimeCharacters()) {
      if (character.org !== currentOrg) continue;

      const sheet = getOrBuildSpriteSheet(character);
      const screenX = character.x * tileSize;
      const bobOffset = fastMode || character.state === "walk" ? 0 : bobOffsetFor(now);
      const screenY = character.y * tileSize + bobOffset;
      const pose = character.state === "idle" ? seatedOrIdlePose(character) : poseFor(character, now, fastMode);
      const direction: SpriteDirection = character.direction;

      let alpha = 1;
      if (character.state === "waiting" && !fastMode) {
        const phase = Math.floor(now / WAITING_BLINK_PERIOD_MS) % 2;
        alpha = phase === 0 ? 1 : 0.4;
      }
      ctx.globalAlpha = alpha;
      sheet.draw(ctx, direction, pose, screenX, screenY, SPRITE_SIZE_PX);
      ctx.globalAlpha = 1;

      // z4: オーバーレイ（名前・状態の吹き出し。idle/walk は吹き出し無し）
      drawOverlay(ctx, character, screenX, screenY);
    }
  };

  const frame = (now: number) => {
    if (stopped) return;
    scene.advance(tickFromNow(now));
    draw(now);
    rafId = raf(frame);
  };

  rafId = raf(frame);

  return {
    stop(): void {
      stopped = true;
      if (rafId !== undefined) {
        caf(rafId);
      }
    },
    setFloor(org: string): void {
      if (!findFloor(org)) return; // 未知の org は no-op（現在のフロアを維持）
      currentOrg = org;
    },
  };
}

function bobOffsetFor(now: number): number {
  const phase = (now % BOB_PERIOD_MS) / BOB_PERIOD_MS;
  return Math.sin(phase * Math.PI * 2) * BOB_AMPLITUDE_PX;
}

function seatedOrIdlePose(character: RuntimeCharacter): SpritePose {
  // claim 済み（tool 状態表示中）は着席、それ以外の idle は立ち姿。
  return character.sessionId ? "seated" : "idle";
}

function drawOverlay(ctx: CanvasRenderingContext2D, character: RuntimeCharacter, x: number, y: number): void {
  if (character.state === "idle" || character.state === "walk") {
    return; // README 抽出仕様 2: idle は吹き出し無し。walk も移動中は非表示にする
  }
  const color = STATE_COLORS[character.state];
  ctx.fillStyle = "#12152a";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const label = character.state;
  const boxWidth = label.length * 6 + 8;
  ctx.fillRect(x, y - 16, boxWidth, 12);
  ctx.strokeRect(x, y - 16, boxWidth, 12);
  ctx.fillStyle = color;
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 4, y - 7);

  if (character.name) {
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.font = "9px monospace";
    ctx.fillText(character.name, x, y + 30);
  }
}
