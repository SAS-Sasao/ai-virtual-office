import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "@ai-office/protocol";
import { OfficeState } from "./office-state";
import { buildRuntimeLayout } from "./layout-runtime";
import { Scene } from "./scene";
import { cellFor, startRenderer } from "./renderer";
import type { CanvasFactory, DrawableCanvas, SpriteSourceImage } from "./sprites";
import { REAL_SHAPE_CHARACTERS, REAL_SHAPE_FLOOR } from "./fixtures/real-layout-fixture";

/** 第 2 フロア（別 org）。z0〜z2 のフロア別キャッシュ検証に使う。 */
const SECOND_FLOOR = { ...REAL_SHAPE_FLOOR, org: "jutaku-dev-team" };

function ev(partial: Partial<OfficeEvent> & Pick<OfficeEvent, "type" | "sessionId" | "ts">): OfficeEvent {
  return partial;
}

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

function buildTestSceneWithRoster() {
  const runtimeLayout = buildRuntimeLayout({ version: 1, floors: [REAL_SHAPE_FLOOR] }, REAL_SHAPE_CHARACTERS);
  const officeState = new OfficeState();
  const scene = new Scene(runtimeLayout, REAL_SHAPE_CHARACTERS, officeState, { fastMode: true });
  return { runtimeLayout, scene, officeState };
}

/** strokeRect/fillText の呼び出しを記録するメイン canvas スタブ（M1-4b: フォーカスリング・sub ラベル・ホバーカードの検証用）。 */
function createMainCanvasRecordingStub(): {
  canvas: HTMLCanvasElement;
  strokeRectCalls: Array<{ strokeStyle: unknown; x: number; y: number; w: number; h: number }>;
  fillTextCalls: Array<{ text: string; x: number; y: number }>;
} {
  const strokeRectCalls: Array<{ strokeStyle: unknown; x: number; y: number; w: number; h: number }> = [];
  const fillTextCalls: Array<{ text: string; x: number; y: number }> = [];
  const ctx = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    globalAlpha: 1,
    font: "10px monospace",
    textAlign: "left" as CanvasTextAlign,
    fillRect: () => {},
    strokeRect: (x: number, y: number, w: number, h: number) => {
      strokeRectCalls.push({ strokeStyle: ctx.strokeStyle, x, y, w, h });
    },
    fillText: (text: string, x: number, y: number) => {
      fillTextCalls.push({ text, x, y });
    },
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
  };
  const canvas = {
    width: 960,
    height: 540,
    getContext: (kind: string) => (kind === "2d" ? ctx : null),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, strokeRectCalls, fillTextCalls };
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

describe("startRenderer: focus ring / sub label / hover card (M1-4b AC-4/AC-6)", () => {
  it("draws exactly one focus ring (#ffd166 stroke) for the character matching scene.focusSessionId, per frame", () => {
    const { runtimeLayout, scene, officeState } = buildTestSceneWithRoster();
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    scene.focusSessionId("sess-1");

    const { factory } = createStubCanvasFactory();
    const { canvas, strokeRectCalls } = createMainCanvasRecordingStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0);

    const ringCalls = strokeRectCalls.filter((c) => c.strokeStyle === "#ffd166");
    expect(ringCalls).toHaveLength(1);

    handle.stop();
  });

  it("does not draw a focus ring when no character matches scene.focusSessionId (unfocused)", () => {
    const { runtimeLayout, scene } = buildTestSceneWithRoster();

    const { factory } = createStubCanvasFactory();
    const { canvas, strokeRectCalls } = createMainCanvasRecordingStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0);

    expect(strokeRectCalls.filter((c) => c.strokeStyle === "#ffd166")).toHaveLength(0);

    handle.stop();
  });

  it("draws a 'sub' label for subagent (kind: 'sub') characters", () => {
    const { runtimeLayout, scene, officeState } = buildTestSceneWithRoster();
    officeState.applyEvent(ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection" }));
    officeState.applyEvent(
      ev({ type: "pre_tool", sessionId: "sess-1", toolName: "Task", subagentType: "a", ts: 1100, org: "domain-tech-collection", dept: "dept-research" }),
    );

    const { factory } = createStubCanvasFactory();
    const { canvas, fillTextCalls } = createMainCanvasRecordingStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0);

    expect(fillTextCalls.some((c) => c.text === "sub")).toBe(true);

    handle.stop();
  });

  it("draws the hover detail card exactly once (state-colored border) when scene.getHoveredCharacter() is set", () => {
    const { runtimeLayout, scene, officeState } = buildTestSceneWithRoster();
    officeState.applyEvent(
      ev({ type: "session_start", sessionId: "sess-1", ts: 1000, org: "domain-tech-collection", dept: "dept-research", role: "tech-researcher" }),
    );
    // researcher の自席 (2,4) を指す（AC-6 のヒットテストと同じ計算）
    scene.setPointer(2 * REAL_SHAPE_FLOOR.grid.tileSize + 5, 4 * REAL_SHAPE_FLOOR.grid.tileSize + 5);
    expect(scene.getHoveredCharacter()).not.toBeNull();

    const { factory } = createStubCanvasFactory();
    const { canvas, strokeRectCalls, fillTextCalls } = createMainCanvasRecordingStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0);

    // カード枠は状態色（claim 直後は post_tool 等が無いので idle 色 "#9aa0b8"）。
    // カードの幅（168px）で他の strokeRect（オーバーレイの吹き出し枠等）と区別する。
    const cardBorderCalls = strokeRectCalls.filter((c) => c.strokeStyle === "#9aa0b8" && c.w === 168);
    expect(cardBorderCalls).toHaveLength(1);
    // 部署の行がカード本文に描画されている
    expect(fillTextCalls.some((c) => c.text === "dept-research")).toBe(true);

    handle.stop();
  });

  it("does not draw the hover card when nothing is hovered", () => {
    const { runtimeLayout, scene } = buildTestSceneWithRoster();

    const { factory } = createStubCanvasFactory();
    const { canvas, strokeRectCalls } = createMainCanvasRecordingStub();
    const raf = createManualRaf();

    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    });

    raf.pump(0);

    expect(strokeRectCalls.filter((c) => c.w === 168)).toHaveLength(0);

    handle.stop();
  });
});

describe("cellFor (M2-1 AC-3): every roster role/dept maps to a valid sheet cell", () => {
  const SW = 384;
  const SH = 512;
  // AC-3 で列挙された 8 dept（col 0-3 x row 0-1 の 8 セルへ決定的に割当）。
  const ENUMERATED_DEPTS = [
    "dept-architecture",
    "dept-development",
    "dept-infra",
    "dept-pm",
    "dept-quality",
    "dept-research",
    "dept-retail-domain",
    "dept-secretary",
  ];

  function assertValidCell(role: string, dept: string): void {
    const cell = cellFor(role, dept);
    expect(cell.sw).toBe(SW);
    expect(cell.sh).toBe(SH);
    const col = cell.sx / SW;
    const row = cell.sy / SH;
    expect(Number.isInteger(col)).toBe(true);
    expect(Number.isInteger(row)).toBe(true);
    expect(col).toBeGreaterThanOrEqual(0);
    expect(col).toBeLessThanOrEqual(3);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(row).toBeLessThanOrEqual(1);
  }

  it("maps all enumerated depts to col 0-3 / row 0-1", () => {
    for (const dept of ENUMERATED_DEPTS) assertValidCell("any-role", dept);
  });

  it("falls back to a valid cell for unknown/empty dept and role (default = engineer)", () => {
    assertValidCell("mystery-role", "dept-does-not-exist");
    assertValidCell("", "");
  });

  it("is deterministic (same input → same output)", () => {
    expect(cellFor("lead-developer", "dept-development")).toEqual(cellFor("lead-developer", "dept-development"));
    // dept-research と dept-retail-domain は同一セルを共有する（制服的表現・決定的）
    expect(cellFor("tech-researcher", "dept-research")).toEqual(cellFor("retail-domain-researcher", "dept-retail-domain"));
  });

  it("maps every real ~/.ai-office roster role/dept (or the enumerated depts) to a valid cell", () => {
    // 実生成ロースタがある環境ではそれを全数反復する。無い環境（クリーンチェックアウト
    // 等）では AC-3 列挙 8 dept を反復する（どちらでも非空・全数 assert = 取りこぼしゼロ）。
    const rosterPath = join(homedir(), ".ai-office", "layouts", "characters.json");
    const entries: Array<{ role: string; dept: string }> = existsSync(rosterPath)
      ? (JSON.parse(readFileSync(rosterPath, "utf8")) as Array<{ role: string; dept: string }>)
      : ENUMERATED_DEPTS.map((dept) => ({ role: "roster-role", dept }));
    expect(entries.length).toBeGreaterThan(0);
    for (const { role, dept } of entries) assertValidCell(role, dept);
  });
});

describe("startRenderer: sprite source selection (M2-1 AC-4/AC-9)", () => {
  // 注入するスタブ画像（PNG 経路で使われたことを drawImage の source 同一性で判定する）。
  const OFFICE_IMAGE: SpriteSourceImage = { width: 1536, height: 1024 };

  /** 解決/棄却を手動制御できるローダ（sleep 禁止・決定論。ロード呼び出し回数も数える）。 */
  function createControllableLoader() {
    let resolveFn: (image: SpriteSourceImage) => void = () => {};
    let rejectFn: (reason: unknown) => void = () => {};
    const state = { calls: 0 };
    let promise: Promise<SpriteSourceImage> = Promise.resolve(OFFICE_IMAGE);
    const loader = () => {
      state.calls += 1;
      promise = new Promise<SpriteSourceImage>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      return promise;
    };
    return {
      loader,
      state,
      resolve: () => {
        resolveFn(OFFICE_IMAGE);
        return promise;
      },
      reject: () => {
        rejectFn(new Error("load failed"));
        return promise;
      },
    };
  }

  /** スプライトの draw は drawImage を 9 引数で呼ぶ（フロアレイヤーの blit は 3 引数）。 */
  function spriteDrawCalls(drawImageCalls: unknown[][]): unknown[][] {
    return drawImageCalls.filter((args) => args.length === 9);
  }

  function startWithLoader(loader: ((...a: never[]) => Promise<SpriteSourceImage>) | undefined) {
    const { runtimeLayout, scene } = buildTestSceneWithRoster();
    const { factory, created } = createStubCanvasFactory();
    const { canvas, drawImageCalls } = createMainCanvasStub();
    const raf = createManualRaf();
    const handle = startRenderer(canvas, scene, runtimeLayout, {
      canvasFactory: factory,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
      spriteImageLoader: loader,
    });
    return { handle, raf, drawImageCalls, created };
  }

  it("uses generated sprites (not the PNG) when no loader is injected (AC-4)", () => {
    const { handle, raf, drawImageCalls } = startWithLoader(undefined);
    raf.pump(0);
    const sprites = spriteDrawCalls(drawImageCalls);
    expect(sprites.length).toBeGreaterThan(0);
    expect(sprites.every((args) => args[0] !== OFFICE_IMAGE)).toBe(true);
    handle.stop();
  });

  it("uses generated sprites while the injected loader is still unresolved (AC-4)", () => {
    const ctl = createControllableLoader();
    const { handle, raf, drawImageCalls } = startWithLoader(ctl.loader);
    raf.pump(0);
    const sprites = spriteDrawCalls(drawImageCalls);
    expect(sprites.length).toBeGreaterThan(0);
    expect(sprites.every((args) => args[0] !== OFFICE_IMAGE)).toBe(true);
    handle.stop();
  });

  it("switches to PNG sprites after the loader resolves (AC-4)", async () => {
    const ctl = createControllableLoader();
    const { handle, raf, drawImageCalls } = startWithLoader(ctl.loader);
    raf.pump(0); // ロード前: generated
    await ctl.resolve(); // renderer の .then（officeImage 設定 + cache クリア）を反映
    raf.pump(16); // ロード後: PNG
    const sprites = spriteDrawCalls(drawImageCalls);
    expect(sprites.some((args) => args[0] === OFFICE_IMAGE)).toBe(true);
    handle.stop();
  });

  it("stays on generated sprites when the loader rejects (no retry) (AC-4)", async () => {
    const ctl = createControllableLoader();
    const { handle, raf, drawImageCalls } = startWithLoader(ctl.loader);
    raf.pump(0);
    await ctl.reject().catch(() => {});
    raf.pump(16);
    const sprites = spriteDrawCalls(drawImageCalls);
    expect(sprites.length).toBeGreaterThan(0);
    expect(sprites.every((args) => args[0] !== OFFICE_IMAGE)).toBe(true);
    handle.stop();
  });

  it("calls the image loader exactly once and does not rebuild sheets every frame (AC-9)", async () => {
    const ctl = createControllableLoader();
    const { handle, raf, created } = startWithLoader(ctl.loader);
    raf.pump(0);
    await ctl.resolve(); // cache を 1 回クリア
    const createdAfterResolve = created.length;
    raf.pump(16); // PNG シートを再構築（loadSpriteSheetFromImage は canvasFactory を使わない）
    raf.pump(32); // 以降は cache ヒット
    raf.pump(48);
    // ローダは 1 回だけ呼ばれる
    expect(ctl.state.calls).toBe(1);
    // PNG シートは canvasFactory を使わない = ロード後は新規 canvas が増えない（毎フレーム再構築していない）
    expect(created.length).toBe(createdAfterResolve);
    handle.stop();
  });
});
