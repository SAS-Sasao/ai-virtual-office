import { describe, expect, it } from "vitest";
import { OfficeState } from "./office-state";
import { buildRuntimeLayout } from "./layout-runtime";
import { Scene } from "./scene";
import { startRenderer } from "./renderer";
import type { CanvasFactory, DrawableCanvas } from "./sprites";
import { REAL_SHAPE_FLOOR } from "./fixtures/real-layout-fixture";

/** 第 2 フロア（別 org）。z0〜z2 のフロア別キャッシュ検証に使う。 */
const SECOND_FLOOR = { ...REAL_SHAPE_FLOOR, org: "jutaku-dev-team" };

function createStubCanvasFactory(): { factory: CanvasFactory; created: DrawableCanvas[] } {
  const created: DrawableCanvas[] = [];
  const factory: CanvasFactory = (width, height) => {
    const ctx = {
      fillStyle: "#000000",
      strokeStyle: "#000000",
      lineWidth: 1,
      globalAlpha: 1,
      font: "10px monospace",
      textAlign: "left" as CanvasTextAlign,
      fillRect: () => {},
      strokeRect: () => {},
      fillText: () => {},
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
    };
    const canvas: DrawableCanvas = {
      width,
      height,
      getContext: (kind) => (kind === "2d" ? (ctx as unknown as CanvasRenderingContext2D) : null),
    };
    created.push(canvas);
    return canvas;
  };
  return { factory, created };
}

function createMainCanvasStub(): { canvas: HTMLCanvasElement; drawImageCalls: unknown[][] } {
  const drawImageCalls: unknown[][] = [];
  const ctx = {
    fillStyle: "#000000",
    globalAlpha: 1,
    font: "10px monospace",
    textAlign: "left" as CanvasTextAlign,
    fillRect: () => {},
    strokeRect: () => {},
    fillText: () => {},
    drawImage: (...args: unknown[]) => {
      drawImageCalls.push(args);
    },
    save: () => {},
    restore: () => {},
    translate: () => {},
  };
  const canvas = {
    width: 960,
    height: 540,
    getContext: (kind: string) => (kind === "2d" ? ctx : null),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, drawImageCalls };
}

function createManualRaf(): {
  requestAnimationFrame: (cb: (t: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  pump: (now: number) => void;
  cancelledIds: number[];
} {
  const queue: Array<(t: number) => void> = [];
  const cancelledIds: number[] = [];
  let nextId = 1;
  return {
    requestAnimationFrame: (cb) => {
      queue.push(cb);
      return nextId++;
    },
    cancelAnimationFrame: (id) => {
      cancelledIds.push(id);
    },
    pump: (now: number) => {
      const cb = queue.shift();
      cb?.(now);
    },
    cancelledIds,
  };
}

function buildTestScene(floors = [REAL_SHAPE_FLOOR]) {
  const runtimeLayout = buildRuntimeLayout({ version: 1, floors }, []);
  const officeState = new OfficeState();
  // 描画呼び出し回数の検証を単純化するため、キャラは 0 体にする
  // （AC-8 の対象は z0〜z2 の静的レイヤーであり、z3 のスプライト構築回数と混同しない）。
  const scene = new Scene(runtimeLayout, [], officeState, { fastMode: true });
  return { runtimeLayout, scene };
}

// 静的レイヤーの canvas は cols*tileSize x rows*tileSize（フロア全体）で作られる。
// これでスプライトアトラス（20*4 x 28*4）と区別してフィルタする。
function isFloorLayerCanvas(canvas: DrawableCanvas, floor = REAL_SHAPE_FLOOR): boolean {
  return canvas.width === floor.grid.cols * floor.grid.tileSize && canvas.height === floor.grid.rows * floor.grid.tileSize;
}

describe("startRenderer: static layer caching (AC-8)", () => {
  it("builds the z0-z2 floor layer via canvasFactory exactly once across many frames", () => {
    const { runtimeLayout, scene } = buildTestScene();
    const { factory, created } = createStubCanvasFactory();
    const { canvas } = createMainCanvasStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    for (let i = 0; i < 10; i += 1) {
      raf.pump(i * 16);
    }

    const floorLayerBuilds = created.filter((c) => isFloorLayerCanvas(c));
    expect(floorLayerBuilds).toHaveLength(1);

    handle.stop();
  });

  it("blits the cached floor layer with exactly one drawImage call per frame", () => {
    const { runtimeLayout, scene } = buildTestScene();
    const { factory } = createStubCanvasFactory();
    const { canvas, drawImageCalls } = createMainCanvasStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0);
    raf.pump(16);
    raf.pump(32);

    // フレームごとに 1 回だけ drawImage（キャッシュ済みレイヤーの blit）
    expect(drawImageCalls).toHaveLength(3);

    handle.stop();
  });

  it("rebuilds the layer only when setFloor switches to a not-yet-cached org", () => {
    // 両フロアとも grid の cols/rows/tileSize が同一（fixture を org だけ変えて複製した
    // もの）のため、生成される canvas はサイズで区別できない。ここでは
    // canvasFactory の**呼び出し回数**の推移だけをチェックポイントごとに見る
    // （初回構築 → 新フロアで 1 回増加 → 既存フロアへ戻っても増加しない）。
    const { runtimeLayout, scene } = buildTestScene([REAL_SHAPE_FLOOR, SECOND_FLOOR]);
    const { factory, created } = createStubCanvasFactory();
    const { canvas } = createMainCanvasStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0); // 初期フロアのレイヤーを構築
    expect(created).toHaveLength(1);

    handle.setFloor("jutaku-dev-team");
    raf.pump(16); // 新フロアのレイヤーを構築 (+1)
    expect(created).toHaveLength(2);

    handle.setFloor("domain-tech-collection");
    raf.pump(32); // 既存フロアへ戻る: 再構築しない（キャッシュ済み）
    expect(created).toHaveLength(2);

    handle.stop();
  });

  it("setFloor to an unknown org is a no-op (keeps the current floor)", () => {
    const { runtimeLayout, scene } = buildTestScene();
    const { factory, created } = createStubCanvasFactory();
    const { canvas } = createMainCanvasStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0);
    handle.setFloor("does-not-exist");
    raf.pump(16);

    expect(created.filter((c) => isFloorLayerCanvas(c))).toHaveLength(1);
    handle.stop();
  });
});

describe("startRenderer: lifecycle", () => {
  it("stop() cancels the animation frame and further pumps do not draw again", () => {
    const { runtimeLayout, scene } = buildTestScene();
    const { factory } = createStubCanvasFactory();
    const { canvas, drawImageCalls } = createMainCanvasStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0);
    expect(drawImageCalls).toHaveLength(1);

    handle.stop();
    expect(raf.cancelledIds).toHaveLength(1);

    // stop 後にキューへ積まれた次フレームは無い（cancel 済み）ため、pump しても何も起きない
    raf.pump(16);
    expect(drawImageCalls).toHaveLength(1);
  });
});
