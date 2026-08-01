import { describe, expect, it } from "vitest";
import {
  createGeneratedSpriteSheet,
  loadSpriteSheetFromImage,
  type CanvasFactory,
  type DrawableCanvas,
} from "./sprites";

interface RecordedFillRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

interface RecordedDrawImage {
  args: unknown[];
}

/** テスト用の描画呼び出し記録スタブ（node 環境には Canvas が無いための注入）。 */
function createStubCanvasFactory(): {
  factory: CanvasFactory;
  canvases: Array<{
    width: number;
    height: number;
    fillRectCalls: RecordedFillRect[];
    drawImageCalls: RecordedDrawImage[];
  }>;
} {
  const canvases: Array<{
    width: number;
    height: number;
    fillRectCalls: RecordedFillRect[];
    drawImageCalls: RecordedDrawImage[];
  }> = [];

  const factory: CanvasFactory = (width: number, height: number): DrawableCanvas => {
    const fillRectCalls: RecordedFillRect[] = [];
    const drawImageCalls: RecordedDrawImage[] = [];
    let fillStyle = "#000000";

    const record = { width, height, fillRectCalls, drawImageCalls };
    canvases.push(record);

    const ctx = {
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string) {
        fillStyle = value;
      },
      fillRect(x: number, y: number, w: number, h: number) {
        fillRectCalls.push({ x, y, w, h, color: fillStyle });
      },
      drawImage(...args: unknown[]) {
        drawImageCalls.push({ args });
      },
    };

    return {
      width,
      height,
      getContext: (kind: "2d") => (kind === "2d" ? (ctx as unknown as CanvasRenderingContext2D) : null),
    };
  };

  return { factory, canvases };
}

describe("createGeneratedSpriteSheet", () => {
  it("builds the atlas via the injected canvas factory exactly once", () => {
    const { factory, canvases } = createStubCanvasFactory();
    createGeneratedSpriteSheet({ hair: "#20304a", body: "#7ef29a" }, factory);

    expect(canvases).toHaveLength(1);
  });

  it("sizes the atlas as (frameWidth * 4 poses) x (frameHeight * 4 directions)", () => {
    const { factory, canvases } = createStubCanvasFactory();
    const sheet = createGeneratedSpriteSheet({ hair: "#20304a", body: "#7ef29a" }, factory);

    expect(canvases[0].width).toBe(sheet.frameWidth * 4);
    expect(canvases[0].height).toBe(sheet.frameHeight * 4);
  });

  it("paints at least one pixel using the character's body color", () => {
    const { factory, canvases } = createStubCanvasFactory();
    createGeneratedSpriteSheet({ hair: "#20304a", body: "#ff00ff" }, factory);

    const bodyPixels = canvases[0].fillRectCalls.filter((c) => c.color === "#ff00ff");
    expect(bodyPixels.length).toBeGreaterThan(0);
  });

  it("paints at least one pixel using the character's hair color", () => {
    const { factory, canvases } = createStubCanvasFactory();
    createGeneratedSpriteSheet({ hair: "#123456", body: "#7ef29a" }, factory);

    const hairPixels = canvases[0].fillRectCalls.filter((c) => c.color === "#123456");
    expect(hairPixels.length).toBeGreaterThan(0);
  });

  it("draws fewer filled pixels for the seated pose than the idle pose (legs hidden)", () => {
    const { factory, canvases } = createStubCanvasFactory();
    createGeneratedSpriteSheet({ hair: "#20304a", body: "#7ef29a" }, factory);
    const sheet = createGeneratedSpriteSheet({ hair: "#20304a", body: "#7ef29a" }, factory);
    void sheet;

    // atlas は poses 順 (idle, walk0, walk1, seated) x directions 順 (down, up, left, right)
    // のグリッドに描かれる。各セルの矩形範囲でフィルタして画素数を比較する。
    const idleCellPixelCount = canvases[1].fillRectCalls.filter((c) => c.x < canvases[1].width / 4 && c.y < canvases[1].height / 4).length;
    const seatedCellPixelCount = canvases[1].fillRectCalls.filter(
      (c) => c.x >= (canvases[1].width * 3) / 4 && c.y < canvases[1].height / 4,
    ).length;

    expect(seatedCellPixelCount).toBeLessThan(idleCellPixelCount);
  });

  it("draw() issues exactly one drawImage call per invocation", () => {
    const { factory, canvases } = createStubCanvasFactory();
    const sheet = createGeneratedSpriteSheet({ hair: "#20304a", body: "#7ef29a" }, factory);

    const mainCanvasFactory = createStubCanvasFactory();
    const mainCanvas = mainCanvasFactory.factory(100, 100);
    const mainCtx = mainCanvas.getContext("2d")!;

    sheet.draw(mainCtx, "down", "idle", 10, 10, 24);

    expect(mainCanvasFactory.canvases[0].drawImageCalls).toHaveLength(1);
    // 参照した atlas キャンバスが 1 枚だけ生成されていることの確認（atlas 自体は再構築されない）
    expect(canvases).toHaveLength(1);
  });

  it("draw() reads from a different source rect for each direction/pose combination", () => {
    const { factory } = createStubCanvasFactory();
    const sheet = createGeneratedSpriteSheet({ hair: "#20304a", body: "#7ef29a" }, factory);

    const mainCanvasFactory = createStubCanvasFactory();
    const mainCanvas = mainCanvasFactory.factory(100, 100);
    const mainCtx = mainCanvas.getContext("2d")!;

    sheet.draw(mainCtx, "down", "idle", 0, 0, 24);
    sheet.draw(mainCtx, "up", "walk0", 0, 0, 24);

    const [firstCall, secondCall] = mainCanvasFactory.canvases[0].drawImageCalls;
    // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) の sx/sy (index 1,2) が異なる
    expect([firstCall.args[1], firstCall.args[2]]).not.toEqual([secondCall.args[1], secondCall.args[2]]);
  });
});

/**
 * save/translate/scale/drawImage を純増で記録するスタブ ctx（AC-2 の水平反転検証用。
 * 既存の createStubCanvasFactory には手を入れず、この層だけを追加する = 純増）。
 */
interface RecordedCall {
  op: string;
  args: unknown[];
}
function createRecordingCtx(): { ctx: CanvasRenderingContext2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const ctx = {
    save: () => calls.push({ op: "save", args: [] }),
    restore: () => calls.push({ op: "restore", args: [] }),
    translate: (...args: unknown[]) => calls.push({ op: "translate", args }),
    scale: (...args: unknown[]) => calls.push({ op: "scale", args }),
    drawImage: (...args: unknown[]) => calls.push({ op: "drawImage", args }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("loadSpriteSheetFromImage (M2-1 ADR-005)", () => {
  // オフィスシート: 1536x1024・4 列 x 2 行 = 1 セル 384x512。
  const IMAGE = { width: 1536, height: 1024 };

  it("reports frameWidth/frameHeight from the given cell", () => {
    const sheet = loadSpriteSheetFromImage(IMAGE, { sx: 0, sy: 0, sw: 384, sh: 512 });
    expect(sheet.frameWidth).toBe(384);
    expect(sheet.frameHeight).toBe(512);
  });

  it("blits exactly the given cell's source rect once, scaling height by sh/sw (AC-1)", () => {
    const sheet = loadSpriteSheetFromImage(IMAGE, { sx: 384, sy: 512, sw: 384, sh: 512 });
    const { ctx, calls } = createRecordingCtx();

    sheet.draw(ctx, "down", "idle", 10, 20, 24);

    const draws = calls.filter((c) => c.op === "drawImage");
    expect(draws).toHaveLength(1);
    // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(draws[0].args[0]).toBe(IMAGE);
    expect(draws[0].args.slice(1, 5)).toEqual([384, 512, 384, 512]);
    // dest: dx,dy そのまま、幅 size=24、高さ = size*(sh/sw) = 24*(512/384) = 32
    expect(draws[0].args.slice(5)).toEqual([10, 20, 24, 32]);
  });

  it("horizontally flips 'left' via save/translate/scale(-1,1) (AC-2)", () => {
    const sheet = loadSpriteSheetFromImage(IMAGE, { sx: 0, sy: 0, sw: 384, sh: 512 });
    const { ctx, calls } = createRecordingCtx();

    sheet.draw(ctx, "left", "idle", 100, 50, 24);

    expect(calls.some((c) => c.op === "save")).toBe(true);
    expect(calls.some((c) => c.op === "restore")).toBe(true);
    expect(calls.some((c) => c.op === "translate")).toBe(true);
    const scale = calls.find((c) => c.op === "scale");
    expect(scale?.args).toEqual([-1, 1]);
    // 反転しても drawImage は 1 回・同じソース矩形
    const draws = calls.filter((c) => c.op === "drawImage");
    expect(draws).toHaveLength(1);
    expect(draws[0].args.slice(1, 5)).toEqual([0, 0, 384, 512]);
  });

  it("does not flip (no save/scale) for non-left directions (AC-2)", () => {
    const sheet = loadSpriteSheetFromImage(IMAGE, { sx: 0, sy: 0, sw: 384, sh: 512 });
    for (const dir of ["down", "up", "right"] as const) {
      const { ctx, calls } = createRecordingCtx();
      sheet.draw(ctx, dir, "idle", 0, 0, 24);
      expect(calls.some((c) => c.op === "scale")).toBe(false);
      expect(calls.some((c) => c.op === "save")).toBe(false);
      expect(calls.filter((c) => c.op === "drawImage")).toHaveLength(1);
    }
  });
});
