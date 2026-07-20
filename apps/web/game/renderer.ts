import type { CharacterState } from "./protocol";
import type { OfficeState } from "./office-state";

// アーキ設計 §4 のとおり、描画ロジックは単体テスト対象外として割り切る
// （M0 では「四角が色を変える」だけで良い。スプライト・部屋・経路探索は未実装）。
// 見た目仕様（状態別の色）は docs/design/ui/ の抽出仕様を正とする。
const STATE_COLORS: Record<CharacterState, string> = {
  idle: "#8a7458",
  type: "#7ef29a",
  read: "#6be5ff",
  terminal: "#c39bff",
  browsing: "#5aa2ff",
  thinking: "#b39b78",
  waiting: "#ffd166",
  done: "#ffffff",
};

const BACKGROUND_COLOR = "#141017";
const DESK_BORDER_COLOR = "#3a2415";

const CHARACTER_SIZE = 32;
const DESK_WIDTH = 48;
const DESK_HEIGHT = 40;
const DESK_GAP = 16;
const DESK_MARGIN_TOP = 24;
const DESK_MARGIN_LEFT = 24;
const WAITING_BLINK_PERIOD_MS = 500;

/**
 * Canvas 2D への requestAnimationFrame 描画ループを開始する。
 * 戻り値の停止関数を呼ぶと cancelAnimationFrame でループを止める。
 */
export function startRenderer(canvas: HTMLCanvasElement, state: OfficeState): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context is not available");
  }

  let rafId: number;
  let stopped = false;

  const frame = (now: number) => {
    if (stopped) {
      return;
    }
    draw(ctx, canvas, state, now);
    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
  };
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  state: OfficeState,
  now: number,
): void {
  const width = canvas.width;
  const height = canvas.height;

  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, height);

  const sessions = state.getSnapshot().sessions;

  drawDesks(ctx, sessions.length);
  sessions.forEach((session, index) => {
    drawCharacter(ctx, index, session.sessionId, session.state, now);
  });
}

function drawDesks(ctx: CanvasRenderingContext2D, count: number): void {
  const deskCount = Math.max(count, 1);
  ctx.strokeStyle = DESK_BORDER_COLOR;
  ctx.lineWidth = 2;

  for (let i = 0; i < deskCount; i += 1) {
    const x = deskPositionX(i);
    const y = DESK_MARGIN_TOP;
    ctx.strokeRect(x, y, DESK_WIDTH, DESK_HEIGHT);
  }
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  index: number,
  sessionId: string,
  state: CharacterState,
  now: number,
): void {
  const x = deskPositionX(index) + (DESK_WIDTH - CHARACTER_SIZE) / 2;
  const y = DESK_MARGIN_TOP + DESK_HEIGHT + 8;

  const color = STATE_COLORS[state];
  ctx.fillStyle = color;

  if (state === "waiting") {
    const phase = Math.floor(now / WAITING_BLINK_PERIOD_MS) % 2;
    ctx.globalAlpha = phase === 0 ? 1 : 0.4;
  } else {
    ctx.globalAlpha = 1;
  }

  ctx.fillRect(x, y, CHARACTER_SIZE, CHARACTER_SIZE);
  ctx.globalAlpha = 1;

  ctx.fillStyle = "#ffffff";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";

  ctx.fillText(state, x + CHARACTER_SIZE / 2, y - 4);
  ctx.fillText(sessionId.slice(0, 8), x + CHARACTER_SIZE / 2, y + CHARACTER_SIZE + 12);
}

// TODO(M1): 複数セッション時の折り返し配置（NFR-1 の 30 体で canvas 幅 960 を超えるため）
function deskPositionX(index: number): number {
  return DESK_MARGIN_LEFT + index * (DESK_WIDTH + DESK_GAP);
}
