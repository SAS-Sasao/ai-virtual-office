// キャラクタースプライトシート生成（M1-4a・ADR-004）。
//
// 素材は「自前生成シートで先行し、PNG ロードは後日差し替え」（2026-07-25 人間承認・
// decision-log ADR-004。ADR-002『PNG スプライトシート』の実装段階付け）。
// ピクセルマップは docs/design/ui/ai-virtual-office.dc.html の v2（box-shadow ドット絵）
// リビジョンにあった `sprite()` メソッドの 10x14 ドット配列を移植したもの
// （自作コード。NFR-6/AC-11 の「外部素材ゼロ」判定の対象外＝画像ファイルを一切
// 追加しない）。実行時に offscreen canvas 上へ焼き込み、1 枚のアトラスから
// drawImage で切り出す（`SpriteSheet` インターフェースは将来
// `loadSpriteSheetFromImage(png)` に差し替え可能にするための接続点）。
//
// 方向・ポーズの作り分けは元の 1 ポーズ（正面向き立ち姿）からの手続き的な
// 変換であり、真の側面ドット絵ではない簡易実装であることを明記する
// （up = 顔パーツを髪色に置換した後頭部シルエット、right = base の左右反転、
//  walk0/walk1 = 脚の行を左右にローテートしたストライド演出、
//  seated = 脚・靴の行を透明化）。

export type SpriteDirection = "down" | "up" | "left" | "right";
export type SpritePose = "idle" | "walk0" | "walk1" | "seated";

export interface CharacterPalette {
  /** 髪色。キャラごとに決定的に割り当てる想定（renderer.ts 側の責務）。 */
  hair: string;
  /** 服・体の主色。キャラごとに決定的に割り当てる想定。 */
  body: string;
}

/**
 * HTMLCanvasElement / OffscreenCanvas と、node テスト用スタブの両方を受け入れる
 * ための最小限の構造的インターフェース。sprites.ts はこれ以上 DOM API を要求しない。
 */
export interface DrawableCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): CanvasRenderingContext2D | null;
}

/** offscreen canvas の生成を呼び出し側から注入する（node テストは描画記録スタブ）。 */
export type CanvasFactory = (width: number, height: number) => DrawableCanvas;

export interface SpriteSheet {
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** アトラスから該当フレームを 1 回の drawImage で `dx,dy` へ幅 `size` で描く。 */
  draw(
    ctx: CanvasRenderingContext2D,
    direction: SpriteDirection,
    pose: SpritePose,
    dx: number,
    dy: number,
    size: number,
  ): void;
}

/**
 * `drawImage` のソースに使える最小の構造的インターフェース（ADR-005 の PNG シート実装）。
 * HTMLImageElement / ImageBitmap 等の `CanvasImageSource` と、node テスト用スタブの
 * 両方を受け入れる。**sprites.ts は `new Image()`/DOM を要求しない**（renderer/OfficeView
 * 側が実画像を注入する）ため、この層は Node 環境で単体テスト可能に保たれる（AC-7）。
 */
export interface SpriteSourceImage {
  readonly width: number;
  readonly height: number;
}

/** スプライトシート内の 1 キャラ分のソース矩形（px）。 */
export interface SpriteCell {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * 注入された 1 枚のスプライトシート画像から、`cell` 矩形を 1 キャラとして描く
 * `SpriteSheet` を返す（ADR-005・M2-1）。いただいた素材は単一の正面ポーズのみで
 * 歩行フレームが無いため、**pose は無視**し、`direction==='left'` のときだけ
 * `save()`+`translate()`+`scale(-1,1)` で水平反転して blit する（他方向は素の
 * `drawImage`）。生成コスト（`createGeneratedSpriteSheet` のようなアトラス焼き込み）は
 * 無く、毎回の `draw` は 1 回の `drawImage`（left は反転付き）で済む。
 */
export function loadSpriteSheetFromImage(image: SpriteSourceImage, cell: SpriteCell): SpriteSheet {
  const { sx, sy, sw, sh } = cell;
  const source = image as unknown as CanvasImageSource;
  return {
    frameWidth: sw,
    frameHeight: sh,
    draw(ctx, direction, pose, dx, dy, size) {
      void pose; // 単一ポーズ素材のため pose は無視する（ADR-005 の割り切り）
      const height = size * (sh / sw);
      if (direction === "left") {
        ctx.save();
        ctx.translate(dx + size, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, size, height);
        ctx.restore();
        return;
      }
      ctx.drawImage(source, sx, sy, sw, sh, dx, dy, size, height);
    },
  };
}

// 10x14 ドットの正面向き立ち姿（docs/design/ui/ai-virtual-office.dc.html v2 の
// `sprite()` メソッド内 `base` 配列を移植。1 文字 = 1 ピクセル、'.' は透明）。
const BASE_PIXEL_MAP: readonly string[] = [
  "..hhhhhh..",
  ".hhhhhhhh.",
  ".hhhhhhhh.",
  ".hssssssh.",
  ".ssessess.",
  ".ssssssss.",
  "..ssssss..",
  "..bbbbbb..",
  ".sbbbbbbs.",
  ".sbddddbs.",
  "..bbbbbb..",
  "..ll..ll..",
  "..ll..ll..",
  ".kk....kk.",
];

const PIXEL_COLS = 10;
const PIXEL_ROWS = 14;
const PIXEL_SCALE = 2;
const FRAME_WIDTH = PIXEL_COLS * PIXEL_SCALE;
const FRAME_HEIGHT = PIXEL_ROWS * PIXEL_SCALE;
const LEG_ROW_START = 11;

const OUTLINE_COLOR = "#1a120c";
const SKIN_COLOR = "#f2c9a0";
const EYE_COLOR = "#1e2233";
const SHADE_COLOR = "#141830";
const LEG_COLOR = "#2a3050";
const SHOE_COLOR = "#10131f";

const DIRECTIONS: readonly SpriteDirection[] = ["down", "up", "left", "right"];
const POSES: readonly SpritePose[] = ["idle", "walk0", "walk1", "seated"];

function paletteColor(ch: string, palette: CharacterPalette): string | undefined {
  switch (ch) {
    case "h":
      return palette.hair;
    case "s":
      return SKIN_COLOR;
    case "e":
      return EYE_COLOR;
    case "b":
      return palette.body;
    case "d":
      return SHADE_COLOR;
    case "l":
      return LEG_COLOR;
    case "k":
      return SHOE_COLOR;
    default:
      return undefined;
  }
}

/** 文字列を offset 分だけ右方向へ循環シフトする（歩行ストライドの脚オフセットに使用）。 */
function rotateRow(row: string, offset: number): string {
  const n = row.length;
  const shift = ((offset % n) + n) % n;
  if (shift === 0) return row;
  return row.slice(n - shift) + row.slice(0, n - shift);
}

function applyPose(map: readonly string[], pose: SpritePose): string[] {
  const rows = [...map];
  if (pose === "seated") {
    for (let y = LEG_ROW_START; y < PIXEL_ROWS; y += 1) {
      rows[y] = ".".repeat(PIXEL_COLS);
    }
    return rows;
  }
  if (pose === "walk0") {
    rows[11] = rotateRow(rows[11], 1);
    rows[12] = rotateRow(rows[12], 1);
    return rows;
  }
  if (pose === "walk1") {
    rows[11] = rotateRow(rows[11], -1);
    rows[12] = rotateRow(rows[12], -1);
    return rows;
  }
  return rows; // idle
}

function applyDirection(map: readonly string[], direction: SpriteDirection): string[] {
  if (direction === "right") {
    return map.map((row) => [...row].reverse().join(""));
  }
  if (direction === "up") {
    // 背面向き: 顔（肌・目）を髪色に置き換えて後頭部のシルエットにする簡易実装
    return map.map((row) =>
      [...row].map((ch) => (ch === "s" || ch === "e" ? "h" : ch)).join(""),
    );
  }
  // "down" と "left" は正面向きの base をそのまま使う（簡易実装。ファイル冒頭の説明を参照）
  return [...map];
}

interface PixelPaint {
  x: number;
  y: number;
  color: string;
}

function pixelsFor(direction: SpriteDirection, pose: SpritePose, palette: CharacterPalette): PixelPaint[] {
  const posed = applyPose(BASE_PIXEL_MAP, pose);
  const finalMap = applyDirection(posed, direction);

  const filled = new Set<string>();
  const body: PixelPaint[] = [];
  finalMap.forEach((row, y) => {
    for (let x = 0; x < PIXEL_COLS; x += 1) {
      const color = paletteColor(row[x], palette);
      if (color) {
        filled.add(`${x},${y}`);
        body.push({ x, y, color });
      }
    }
  });

  const outline: PixelPaint[] = [];
  const outlineSeen = new Set<string>();
  const deltas: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const key of filled) {
    const [xs, ys] = key.split(",").map(Number);
    for (const [dx, dy] of deltas) {
      const nx = xs + dx;
      const ny = ys + dy;
      if (nx < 0 || ny < 0 || nx >= PIXEL_COLS || ny >= PIXEL_ROWS) continue;
      const nk = `${nx},${ny}`;
      if (filled.has(nk) || outlineSeen.has(nk)) continue;
      outlineSeen.add(nk);
      outline.push({ x: nx, y: ny, color: OUTLINE_COLOR });
    }
  }

  return [...outline, ...body];
}

/**
 * palette から、方向 4 x ポーズ 4 の全フレームを 1 枚の offscreen canvas アトラスへ
 * 焼き込み、`SpriteSheet` を返す。アトラス生成は 1 回だけ行われる（呼び出しごとに
 * `canvasFactory` を 1 回だけ呼ぶ）。
 */
export function createGeneratedSpriteSheet(palette: CharacterPalette, canvasFactory: CanvasFactory): SpriteSheet {
  const atlasWidth = FRAME_WIDTH * POSES.length;
  const atlasHeight = FRAME_HEIGHT * DIRECTIONS.length;
  const atlas = canvasFactory(atlasWidth, atlasHeight);
  const actx = atlas.getContext("2d");
  if (!actx) {
    throw new Error("2D canvas context is not available for sprite atlas generation");
  }

  DIRECTIONS.forEach((direction, dirIndex) => {
    POSES.forEach((pose, poseIndex) => {
      const originX = poseIndex * FRAME_WIDTH;
      const originY = dirIndex * FRAME_HEIGHT;
      for (const pixel of pixelsFor(direction, pose, palette)) {
        actx.fillStyle = pixel.color;
        actx.fillRect(originX + pixel.x * PIXEL_SCALE, originY + pixel.y * PIXEL_SCALE, PIXEL_SCALE, PIXEL_SCALE);
      }
    });
  });

  return {
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
    draw(ctx, direction, pose, dx, dy, size) {
      const dirIndex = DIRECTIONS.indexOf(direction);
      const poseIndex = POSES.indexOf(pose);
      const sx = poseIndex * FRAME_WIDTH;
      const sy = dirIndex * FRAME_HEIGHT;
      const height = size * (FRAME_HEIGHT / FRAME_WIDTH);
      ctx.drawImage(
        atlas as unknown as CanvasImageSource,
        sx,
        sy,
        FRAME_WIDTH,
        FRAME_HEIGHT,
        dx,
        dy,
        size,
        height,
      );
    },
  };
}
