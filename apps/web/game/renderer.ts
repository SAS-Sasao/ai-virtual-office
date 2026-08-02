import type { CharacterState } from "@ai-office/protocol";
import type { RuntimeFloor, RuntimeLayout } from "./layout-runtime";
import type { HoveredCharacterDetail, RuntimeCharacter } from "./scene";
import { Scene } from "./scene";
import {
  createGeneratedSpriteSheet,
  loadSpriteSheetFromImage,
  type CanvasFactory,
  type CharacterPalette,
  type DrawableCanvas,
  type SpriteCell,
  type SpriteDirection,
  type SpritePose,
  type SpriteSheet,
  type SpriteSourceImage,
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

/**
 * キャラクタースプライトシート画像（ADR-005 のオフィス PNG）を **非同期に 1 回**
 * 返す注入関数。**opt-in**（未注入なら生成スプライトのまま）。本番は OfficeView が
 * `new Image()` で `/assets/characters/office.png` をロードする関数を渡す。
 * game/ 層に `new Image()`/DOM を持ち込まないための境界（React 非依存維持・NFR-7）。
 */
export type SpriteImageLoader = () => Promise<SpriteSourceImage>;

export interface RendererDeps {
  /** z1/z2 のフロアレイヤー・z3 のスプライトアトラス生成に使う offscreen canvas ファクトリ。 */
  canvasFactory: CanvasFactory;
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  /**
   * 任意。渡されたときだけ PNG スプライトシートを試行する（ADR-005・M2-1）。
   * 未注入時は既存どおり `createGeneratedSpriteSheet` を使う（既存 renderer テストは
   * ローダを渡さないため node 環境で `new Image()` を叩かず無回帰・AC-4b）。
   */
  spriteImageLoader?: SpriteImageLoader;
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

// M1-4b: フォーカスリング・ホバー詳細カード（docs/design/ui/README.md 抽出仕様 2）。
const FOCUS_RING_COLOR = "#ffd166";
const SUB_LABEL_TEXT_COLOR = "#9aa0b8";
const CARD_BG_COLOR = "#12152a";
const CARD_WIDTH_PX = 168;
const CARD_HEIGHT_PX = 96;
const CARD_MARGIN_PX = 6;

const WAITING_BLINK_PERIOD_MS = 500;
const BOB_PERIOD_MS = 2600;
const BOB_AMPLITUDE_PX = 2;

// M2-1b: 視覚不具合修正（①小さい ②切り抜きが甘い ③配置がおかしい）。
// スプライトの描画高さ（タイル単位）。幅はシートのフレームアスペクト
// （PNG=cellFor の実測 bbox 比・generated=BASE_PIXEL_MAP 比）から自動算出する。
// **見た目の大きさ調整はこの定数だけで完結する**（:3001 目視での微調整用）。
const SPRITE_HEIGHT_TILES = 2.4;

// 足元(bottom-center)アンカーで固定されるオーバーレイのオフセット定数
// （全て :3001 目視での微調整用に名前付き）。
const BUBBLE_HEIGHT_PX = 12; // 状態吹き出し矩形の高さ（旧実装から流用）
const BUBBLE_GAP_PX = 4; // 吹き出し下端とスプライト上端(dy)の間隔
const NAME_GAP_PX = 2; // 名前ラベルのベースラインとスプライト足元(footY)の間隔
const OVERLAY_CHAR_WIDTH_PX = 6; // 9px monospace の概算 1 文字幅（中央寄せの幅計算用）

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

// ADR-005: オフィス PNG シート（1536x1024・4 列 x 2 行 = 1 マクロセル 384x512）。
// 8 セル（col 0-3 x row 0-1）を線形 index 0-7 で扱う。col = index % 4 / row = floor(index / 4)。

// M2-1b: マクロセル全体（384x512）を描くと余白込みで「小さい・切り抜きが甘い」
// 見た目になっていたため、透過 PNG 化後にアルファ実測した**タイトな bbox**へ
// index ごとに差し替える（値は M2-1b 診断メモの実測値。各 bbox は対応する
// マクロセル内に収まる）。フォールバックは index0。
export const CELL_BBOX: readonly SpriteCell[] = [
  { sx: 80, sy: 45, sw: 232, sh: 442 }, // index0
  { sx: 452, sy: 52, sw: 257, sh: 435 }, // index1
  { sx: 818, sy: 55, sw: 281, sh: 432 }, // index2
  { sx: 1205, sy: 46, sw: 233, sh: 441 }, // index3
  { sx: 69, sy: 526, sw: 278, sh: 440 }, // index4
  { sx: 449, sy: 526, sw: 226, sh: 440 }, // index5
  { sx: 805, sy: 526, sw: 211, sh: 440 }, // index6
  { sx: 1163, sy: 538, sw: 239, sh: 427 }, // index7
];

// dept 起点の決定的セル割当（8 セル < 15 ロールのため複数ロールがセルを共有する。
// 決定的であればよい＝制服的表現）。未登録 dept は既定 = engineer(0) にフォールバックする。
const DEPT_CELL_INDEX: Record<string, number> = {
  "dept-development": 0, // engineer
  "dept-pm": 1, // coordinator
  "dept-architecture": 2, // devops-monitor
  "dept-quality": 3, // analyst
  "dept-infra": 4, // security
  "dept-research": 5, // researcher（虫眼鏡）
  "dept-retail-domain": 5, // researcher（dept-research と共有）
  "dept-secretary": 6, // reception（chat）
};
const DEFAULT_CELL_INDEX = 0; // engineer

/**
 * ロール/部署から PNG シート内のソース矩形（タイトな bbox）を決定的に返す
 * （ADR-005・M2-1・M2-1b・AC-3）。割当は dept 起点で、未登録 dept は engineer(0)
 * にフォールバックするため**全ロースタが有効セルに落ちる**（取りこぼしゼロ）。
 */
export function cellFor(role: string, dept: string): SpriteCell {
  void role; // 現サイクルは dept 起点の割当（role はシグネチャの拡張余地として受ける）
  const index = dept in DEPT_CELL_INDEX ? DEPT_CELL_INDEX[dept] : DEFAULT_CELL_INDEX;
  return CELL_BBOX[index] ?? CELL_BBOX[DEFAULT_CELL_INDEX];
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

  // ADR-005: PNG スプライトシート。ローダが注入されたときだけ 1 回ロードを試みる。
  // ロード完了で spriteCache を一度だけクリアし、次フレームから PNG に差し替える
  // （初回の generated→PNG の一瞬の差し替えは割り切り済み）。reject は generated
  // 据え置きで再試行しない（ローダは 1 回しか呼ばない）。
  let officeSpriteImage: SpriteSourceImage | undefined;
  if (deps.spriteImageLoader) {
    deps
      .spriteImageLoader()
      .then((image) => {
        if (stopped) return;
        officeSpriteImage = image;
        spriteCache.clear();
      })
      .catch(() => {
        // ロード失敗時は generated のまま（officeSpriteImage は undefined を維持）。
      });
  }

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
    // ローダ注入済み かつ シート画像ロード済み → PNG（cellFor は全数マップ）。
    // それ以外（未注入・未ロード・ロード失敗）→ 生成スプライトにフォールバック。
    const sheet =
      deps.spriteImageLoader && officeSpriteImage
        ? loadSpriteSheetFromImage(officeSpriteImage, cellFor(character.role, character.dept))
        : createGeneratedSpriteSheet(paletteForCharacterId(character.id), deps.canvasFactory);
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
    const focusedSessionId = scene.getFocusedSessionId();

    for (const character of scene.getRuntimeCharacters()) {
      if (character.org !== currentOrg) continue;

      const sheet = getOrBuildSpriteSheet(character);
      const screenX = character.x * tileSize;
      const bobOffset = fastMode || character.state === "walk" ? 0 : bobOffsetFor(now);
      const screenY = character.y * tileSize + bobOffset;
      const pose = character.state === "idle" ? seatedOrIdlePose(character) : poseFor(character, now, fastMode);
      const direction: SpriteDirection = character.direction;

      // M2-1b: 足元(bottom-center)アンカー。タイルの水平中央・下端に足が接地する
      // よう描く（大きさは SPRITE_HEIGHT_TILES・接地位置はこのアンカー式で決まる。
      // 幅はシートのフレームアスペクトから自動算出するため PNG/generated 両対応）。
      const drawH = tileSize * SPRITE_HEIGHT_TILES;
      const drawW = drawH * (sheet.frameWidth / sheet.frameHeight);
      const footX = screenX + tileSize / 2;
      const footY = screenY + tileSize;
      const dx = footX - drawW / 2;
      const dy = footY - drawH;

      let alpha = 1;
      if (character.state === "waiting" && !fastMode) {
        const phase = Math.floor(now / WAITING_BLINK_PERIOD_MS) % 2;
        alpha = phase === 0 ? 1 : 0.4;
      }
      ctx.globalAlpha = alpha;
      sheet.draw(ctx, direction, pose, dx, dy, drawW);
      ctx.globalAlpha = 1;

      // z4: オーバーレイ（名前・状態の吹き出し。idle/walk は吹き出し無し。M2-1b:
      // タイル左上ではなくスプライトの実描画範囲（頭上中央/足元）に追従させる）
      drawOverlay(ctx, character, footX, dy, footY);

      // z4: subagent の "sub" 小ラベル（M1-4b）
      if (character.kind === "sub") {
        drawSubLabel(ctx, footX, footY);
      }

      // z4: フォーカスリング（セッション一覧クリック → focusSessionId、M1-4b。
      // M2-1b: タイル全体ではなくスプライトの実描画 bbox を囲む）
      if (focusedSessionId !== null && character.sessionId === focusedSessionId) {
        drawFocusRing(ctx, dx, dy, drawW, drawH);
      }
    }

    // z4: ホバー詳細カード（setPointer のヒットテスト結果。M1-4b）
    const hovered = scene.getHoveredCharacter();
    if (hovered) {
      drawHoverCard(ctx, hovered, width, height);
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

/**
 * z4 オーバーレイ（M2-1b: タイル左上ではなくスプライトの実描画範囲に追従させる）。
 * `centerX` はスプライトの水平中心（footX）、`topY` はスプライト上端（dy）、
 * `footY` は接地点（tile 下端）。吹き出しは頭上中央、名前は足元中央下に描く。
 */
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  character: RuntimeCharacter,
  centerX: number,
  topY: number,
  footY: number,
): void {
  if (character.state === "idle" || character.state === "walk") {
    return; // README 抽出仕様 2: idle は吹き出し無し。walk も移動中は非表示にする
  }
  const color = STATE_COLORS[character.state];
  const label = character.state;
  const boxWidth = label.length * OVERLAY_CHAR_WIDTH_PX + 8;
  const boxX = centerX - boxWidth / 2;
  const boxY = topY - BUBBLE_GAP_PX - BUBBLE_HEIGHT_PX;
  ctx.fillStyle = "#12152a";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.fillRect(boxX, boxY, boxWidth, BUBBLE_HEIGHT_PX);
  ctx.strokeRect(boxX, boxY, boxWidth, BUBBLE_HEIGHT_PX);
  ctx.fillStyle = color;
  ctx.font = "9px monospace";
  ctx.textAlign = "left";
  ctx.fillText(label, boxX + 4, boxY + BUBBLE_HEIGHT_PX - 3);

  if (character.name) {
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    const nameWidth = character.name.length * OVERLAY_CHAR_WIDTH_PX;
    ctx.fillText(character.name, centerX - nameWidth / 2, footY + NAME_GAP_PX);
  }
}

/**
 * subagent（kind: "sub"）を示す小ラベル（M1-4b・scene.ts のファイル冒頭コメント参照）。
 * M2-1b: `footX`/`footY`（スプライトの接地点）中央に追従させる。
 */
function drawSubLabel(ctx: CanvasRenderingContext2D, footX: number, footY: number): void {
  const label = "sub";
  const boxWidth = label.length * OVERLAY_CHAR_WIDTH_PX + 6;
  const boxX = footX - boxWidth / 2;
  const boxY = footY - 4;
  ctx.fillStyle = CARD_BG_COLOR;
  ctx.strokeStyle = SUB_LABEL_TEXT_COLOR;
  ctx.lineWidth = 1;
  ctx.fillRect(boxX, boxY, boxWidth, 10);
  ctx.strokeRect(boxX, boxY, boxWidth, 10);
  ctx.fillStyle = SUB_LABEL_TEXT_COLOR;
  ctx.font = "8px monospace";
  ctx.textAlign = "left";
  ctx.fillText(label, boxX + 3, boxY + 8);
}

/**
 * フォーカスリング（docs/design/ui/README.md 抽出仕様 2: `3px solid #ffd166` /
 * offset 2px。角丸なしの pixel-art トークンに合わせ矩形で描く）。
 * M2-1b: タイル全体ではなく、スプライトの実描画 bbox（`dx,dy,w,h`）を囲む。
 */
function drawFocusRing(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.strokeStyle = FOCUS_RING_COLOR;
  ctx.lineWidth = 3;
  ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
}

/**
 * ホバー詳細カード（README 抽出仕様 2: 名前(ロール) / 部署 / セッション·model /
 * 状態 / ツール / 経過。カード枠は状態色）。canvas 左上に固定表示する
 * （キャンバス座標に依存しない固定位置。ポインタ追従は本サイクルの対象外）。
 */
function drawHoverCard(ctx: CanvasRenderingContext2D, hovered: HoveredCharacterDetail, canvasWidth: number, canvasHeight: number): void {
  void canvasHeight;
  const x = Math.max(CARD_MARGIN_PX, canvasWidth - CARD_WIDTH_PX - CARD_MARGIN_PX);
  const y = CARD_MARGIN_PX;
  const borderColor = STATE_COLORS[hovered.state];

  ctx.fillStyle = CARD_BG_COLOR;
  ctx.fillRect(x, y, CARD_WIDTH_PX, CARD_HEIGHT_PX);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, CARD_WIDTH_PX, CARD_HEIGHT_PX);

  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = "10px monospace";
  ctx.textAlign = "left";

  const nameLine = hovered.name ? `${hovered.name}(${hovered.role})` : hovered.role;
  const sessionLine = `${hovered.sessionId ?? "-"}${hovered.model ? " · " + hovered.model : ""}`;
  const lines = [nameLine, hovered.dept, sessionLine, hovered.state, hovered.toolName ?? "-", `${hovered.elapsedTicks}t`];

  lines.forEach((line, index) => {
    ctx.fillText(line, x + CARD_MARGIN_PX, y + 14 + index * 13);
  });
}
