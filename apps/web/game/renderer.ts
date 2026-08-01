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
// レイヤー構成（ADR-002）: z0 backdrop（`floor.backdrop` の一枚絵 PNG。opt-in の
// backdropImageLoader が注入され当該 src がロード済みなら全面に敷く。それ以外は単色背景。
// M2-2/ADR-006）→ z1 部屋（床材の status 塗り分け・壁・名前プレート・standby 減光。
// backdrop あり時は床塗りを省き枠線 + 名前プレートのみ）→ z2 家具（デスク primitive。
// backdrop あり時はスキップ）→ z3 キャラ（スプライトシート）→ z4 オーバーレイ
// （吹き出し・名前・waiting 明滅）。
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

/**
 * フロア一枚絵背景（`floor.backdrop` の PNG）を **非同期に 1 回** 返す注入関数
 * （M2-2・ADR-006）。**opt-in**（未注入なら従来の単色 z0 のまま）。本番は OfficeView が
 * `new Image()` で `src`（`floor.backdrop` のパス）をロードする関数を渡す。
 * `spriteImageLoader` と同じく、game/ 層に `new Image()`/DOM を持ち込まないための境界
 * （React 非依存維持・NFR-7）。同一 src は呼び出し側でロードするのは 1 回で足りる。
 */
export type BackdropImageLoader = (src: string) => Promise<SpriteSourceImage>;

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
  /**
   * 任意。渡されたときだけ `floor.backdrop`（PNG パス）を z0 に敷く（M2-2・ADR-006）。
   * 未注入時は従来の単色 z0 のまま（既存 renderer テストはローダを渡さないため無回帰・AC-3）。
   */
  backdropImageLoader?: BackdropImageLoader;
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

// ADR-005: オフィス PNG シート（1536x1024・4 列 x 2 行 = 1 セル 384x512）。
const SHEET_CELL_W = 384;
const SHEET_CELL_H = 512;
// 8 セル（col 0-3 x row 0-1）を線形 index 0-7 で扱う。col = index % 4 / row = floor(index / 4)。
const SHEET_COLS = 4;

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
 * ロール/部署から PNG シート内のソース矩形を決定的に返す（ADR-005・M2-1・AC-3）。
 * 割当は dept 起点で、未登録 dept は engineer(0) にフォールバックするため
 * **全ロースタが有効セル（col 0-3・row 0-1）に落ちる**（取りこぼしゼロ）。
 */
export function cellFor(role: string, dept: string): SpriteCell {
  void role; // 現サイクルは dept 起点の割当（role はシグネチャの拡張余地として受ける）
  const index = dept in DEPT_CELL_INDEX ? DEPT_CELL_INDEX[dept] : DEFAULT_CELL_INDEX;
  const col = index % SHEET_COLS;
  const row = Math.floor(index / SHEET_COLS);
  return { sx: col * SHEET_CELL_W, sy: row * SHEET_CELL_H, sw: SHEET_CELL_W, sh: SHEET_CELL_H };
}

function poseFor(character: RuntimeCharacter, now: number, fastMode: boolean): SpritePose {
  if (character.state === "walk" || character.state === "leave") {
    if (fastMode) return "walk0";
    const phase = Math.floor(now / 220) % 2;
    return phase === 0 ? "walk0" : "walk1";
  }
  return "idle";
}

/**
 * z0〜z2 の静的フロアレイヤーを 1 枚の offscreen canvas へ焼き込む。
 *
 * `backdropImage` が渡されたとき（M2-2・ADR-006）は雰囲気レイヤーとして扱い:
 * - z0 を単色 fill から backdrop の `drawImage(bg, 0, 0, width, height)` に置換
 * - z2 家具（デスク primitive）は **描かない**（背景アートのデスクとの二重化を避ける）
 * - z1 は床の status 塗りを省き **枠線 + 名前プレートのみ** 残す（位置把握用。床の
 *   status 別シェーディング＝standby 減光は背景に委ねるため失われる。ADR-006 割り切り②）
 *
 * `backdropImage` が無いときは従来どおり（単色 z0 + 床塗り + 家具）。当たり判定・
 * 経路探索・claim はレイアウトデータで不変（ADR-002 の不変条件）。
 */
function buildFloorLayer(
  floor: RuntimeFloor["floor"],
  canvasFactory: CanvasFactory,
  backdropImage?: SpriteSourceImage,
): DrawableCanvas {
  const width = floor.grid.cols * floor.grid.tileSize;
  const height = floor.grid.rows * floor.grid.tileSize;
  const canvas = canvasFactory(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context is not available for the floor layer");
  }

  const tileSize = floor.grid.tileSize;

  // z0: backdrop。画像ロード済みなら全面拡大で敷く（ADR-006・アスペクト歪みは割り切り①）。
  // 未ロード/未注入時は従来の単色背景。
  if (backdropImage) {
    ctx.drawImage(backdropImage as unknown as CanvasImageSource, 0, 0, width, height);
  } else {
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, width, height);
  }

  // z1: 部屋（backdrop なし = 床材の status 塗り分け + 壁 + 名前プレート /
  //      backdrop あり = 床塗りを省き枠線 + 名前プレートのみ）
  for (const room of floor.rooms) {
    const x = room.x * tileSize;
    const y = room.y * tileSize;
    const w = room.w * tileSize;
    const h = room.h * tileSize;

    if (!backdropImage) {
      ctx.fillStyle = room.status === "active" ? ROOM_FLOOR_ACTIVE : ROOM_FLOOR_STANDBY;
      ctx.globalAlpha = room.status === "active" ? 1 : 0.6; // standby は減光
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
    }

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

  // z2: 家具（デスク primitive）。backdrop あり時はスキップ（二重デスク回避・ADR-006）。
  if (!backdropImage) {
    for (const furniture of floor.furniture) {
      if (furniture.kind !== "desk") continue;
      const x = furniture.x * tileSize;
      const y = furniture.y * tileSize;
      ctx.fillStyle = DESK_COLOR;
      ctx.fillRect(x, y, tileSize, tileSize * 0.7);
      ctx.strokeStyle = BORDER_COLOR;
      ctx.strokeRect(x, y, tileSize, tileSize * 0.7);
    }
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
  // M2-2: ロード済み backdrop 画像を **src キー** で保持する（F2 dedupe）。既定 backdrop を
  // 全フロアに当てると同一 src が複数フロアで共有されるため、org キーだと同じ画像を
  // 何度も decode してしまう。src キーなら素材あたり 1 回のロードで済む（AC-11）。
  const backdropImageBySrc = new Map<string, SpriteSourceImage>();

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

  // M2-2/ADR-006: フロア backdrop（一枚絵背景）。ローダが注入されたときだけ、各
  // `floor.backdrop` の **ユニークな src** を 1 回ずつロードする。完了で、その src を使う
  // 全フロアの floorLayerCache を無効化し、次フレームで backdrop 付きに再構築させる
  // （spriteImageLoader の cache クリア方式と対称）。reject/未ロード/未注入は単色 z0
  // 据え置きで再試行しない（ローダは src あたり 1 回しか呼ばない・無限ループ無し）。
  if (deps.backdropImageLoader) {
    const backdropLoader = deps.backdropImageLoader;
    const requestedSrcs = new Set<string>();
    for (const runtimeFloor of runtimeLayout.floors) {
      const src = runtimeFloor.floor.backdrop;
      if (!src || requestedSrcs.has(src)) continue;
      requestedSrcs.add(src);
      backdropLoader(src)
        .then((image) => {
          if (stopped) return;
          backdropImageBySrc.set(src, image);
          // 同一 src を使う全フロアのレイヤーキャッシュを無効化（次フレームで再構築）。
          for (const f of runtimeLayout.floors) {
            if (f.floor.backdrop === src) floorLayerCache.delete(f.floor.org);
          }
        })
        .catch(() => {
          // ロード失敗時は単色 z0 据え置き（再試行しない）。
        });
    }
  }

  const findFloor = (org: string | undefined): RuntimeFloor | undefined =>
    runtimeLayout.floors.find((f) => f.floor.org === org);

  const getOrBuildFloorLayer = (org: string | undefined): DrawableCanvas | undefined => {
    if (!org) return undefined;
    const cached = floorLayerCache.get(org);
    if (cached) return cached;
    const runtimeFloor = findFloor(org);
    if (!runtimeFloor) return undefined;
    // backdrop 設定 かつ その src がロード済みのときだけ backdrop 付きに焼き込む。
    // 未ロード/未注入/reject は undefined = 従来の単色 z0（据え置き）。
    const src = runtimeFloor.floor.backdrop;
    const backdropImage = src ? backdropImageBySrc.get(src) : undefined;
    const layer = buildFloorLayer(runtimeFloor.floor, deps.canvasFactory, backdropImage);
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

      // z4: subagent の "sub" 小ラベル（M1-4b）
      if (character.kind === "sub") {
        drawSubLabel(ctx, screenX, screenY, tileSize);
      }

      // z4: フォーカスリング（セッション一覧クリック → focusSessionId、M1-4b）
      if (focusedSessionId !== null && character.sessionId === focusedSessionId) {
        drawFocusRing(ctx, screenX, screenY, tileSize);
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

/** subagent（kind: "sub"）を示す小ラベル（M1-4b・scene.ts のファイル冒頭コメント参照）。 */
function drawSubLabel(ctx: CanvasRenderingContext2D, x: number, y: number, tileSize: number): void {
  const label = "sub";
  const boxWidth = label.length * 6 + 6;
  const boxY = y + tileSize - 4;
  ctx.fillStyle = CARD_BG_COLOR;
  ctx.strokeStyle = SUB_LABEL_TEXT_COLOR;
  ctx.lineWidth = 1;
  ctx.fillRect(x, boxY, boxWidth, 10);
  ctx.strokeRect(x, boxY, boxWidth, 10);
  ctx.fillStyle = SUB_LABEL_TEXT_COLOR;
  ctx.font = "8px monospace";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 3, boxY + 8);
}

/**
 * フォーカスリング（docs/design/ui/README.md 抽出仕様 2: `3px solid #ffd166` /
 * offset 2px。角丸なしの pixel-art トークンに合わせ矩形で描く）。
 */
function drawFocusRing(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.strokeStyle = FOCUS_RING_COLOR;
  ctx.lineWidth = 3;
  ctx.strokeRect(x - 2, y - 2, size + 4, size + 4);
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
