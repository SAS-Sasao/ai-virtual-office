"use client";

import { useEffect, useRef, useState } from "react";
import { attachDebug } from "../game/debug";
import { buildRuntimeLayout } from "../game/layout-runtime";
import { OfficeState } from "../game/office-state";
import { OfficeEventSchema, type Character, type OfficeLayout } from "@ai-office/protocol";
import { startRenderer, type RendererHandle } from "../game/renderer";
import { Scene } from "../game/scene";

/** `GET /api/layout` のレスポンス形状（apps/web/lib/layout.ts の OfficeLayoutData と同じ契約）。 */
interface LayoutApiResponse {
  layout: OfficeLayout | null;
  characters: Character[];
}

const EMPTY_LAYOUT_RESPONSE: LayoutApiResponse = { layout: null, characters: [] };

/**
 * `/api/layout` を取得する。ネットワーク不通・非 200・parse 失敗のいずれでも
 * 例外を投げず、レイアウト未インポート環境と同じ `{layout: null, characters: []}`
 * にフォールバックする（NFR-2 と同じ「壊れたデータで落ちない」思想。API 側は
 * 常に 200 を返す契約だが、fetch 自体が失敗するケース（サーバ未起動等）まで
 * この関数で吸収する）。
 */
async function fetchLayoutData(): Promise<LayoutApiResponse> {
  try {
    const res = await fetch("/api/layout");
    if (!res.ok) return EMPTY_LAYOUT_RESPONSE;
    return (await res.json()) as LayoutApiResponse;
  } catch {
    return EMPTY_LAYOUT_RESPONSE;
  }
}

/** `?e2e=1` を fast-mode フラグとして読む（NFR-8）。アニメ時間 0 化のみに使う。 */
function readFastModeFlag(search: string): boolean {
  return new URLSearchParams(search).get("e2e") === "1";
}

// デザイントークン（docs/design/ui/README.md 抽出仕様1）。
const PANEL_BG = "#241a10";
const PANEL_BORDER = "#3a2415";
const TEXT_PRIMARY = "#efe6d6";
const TEXT_SECONDARY = "#b39b78";
const ACCENT_PRIMARY = "#d9a441";
const ACCENT_ACTION = "#7ef29a";

const HARD_SHADOW = "4px 4px 0 #000";

const PRUNE_INTERVAL_MS = 30_000;

/**
 * M0 最小オフィスビュー。
 *
 * 最重要制約: ゲーム状態（セッション・キャラの位置や状態）は React state に
 * 置かない。OfficeState インスタンスは useRef で保持し、描画は
 * game/renderer.ts の requestAnimationFrame ループに委ねる。React state は
 * UI 表示専用の低頻度な値（connected / sessionCount）のみを持つ。
 */
export default function OfficePage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const officeStateRef = useRef<OfficeState | null>(null);
  const sceneRef = useRef<Scene | null>(null);

  const [connected, setConnected] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    let rendererHandle: RendererHandle | null = null;

    const state = new OfficeState();
    officeStateRef.current = state;

    const fastMode = readFastModeFlag(window.location.search);

    // 初期化は /api/layout の fetch 完了を待つ非同期処理だが、SSE 購読・prune
    // タイマー・接続表示は（layout の有無に関わらず）即座に開始する。scene/
    // renderer はレイアウト取得後に組み立て、アンマウント時は disposed フラグで
    // 後始末の二重実行・アンマウント後の起動を防ぐ。
    const init = async (): Promise<void> => {
      const { layout, characters } = await fetchLayoutData();
      if (disposed) return;

      const runtimeLayout = buildRuntimeLayout(layout, characters);
      const scene = new Scene(runtimeLayout, characters, state, { fastMode });
      sceneRef.current = scene;

      attachDebug(scene, runtimeLayout);

      const canvas = canvasRef.current;
      if (canvas) {
        // canvas の解像度（描画座標系）は layout の grid（cols/rows × tileSize）
        // から算出する。layout null 時は buildRuntimeLayout が組み立てる
        // フォールバックレイアウトの寸法になる。JSX 側の width/height は初回
        // 描画までのプレースホルダで、値は変えず imperative に上書きする
        // （React は同一リテラル props を再適用しないため、以後の再レンダリング
        // でも上書きは保持される）。
        const grid = runtimeLayout.floors[0]?.floor.grid;
        if (grid) {
          canvas.width = grid.cols * grid.tileSize;
          canvas.height = grid.rows * grid.tileSize;
        }

        rendererHandle = startRenderer(canvas, scene, runtimeLayout, {
          canvasFactory: (width, height) => {
            const offscreen = document.createElement("canvas");
            offscreen.width = width;
            offscreen.height = height;
            return offscreen;
          },
        });
      }
    };

    void init();

    const unsubscribe = state.subscribe(() => {
      setSessionCount(state.getSnapshot().sessions.length);
    });

    const source = new EventSource("/api/stream");

    // restore（接続直後の直近状態復元）と live（通常配信）は同じ検証・適用経路
    // を通す。順序防御（seq/ts 比較）は state.applyEvent 側（office-state.ts）
    // に一本化されているため、ここでは単純に parse → applyEvent するだけでよい。
    const applyRawEvent = (rawData: string): void => {
      try {
        const parsed = OfficeEventSchema.parse(JSON.parse(rawData));
        state.applyEvent(parsed);
      } catch {
        // 不正な payload（parse 失敗）は無視する。ingest 側の不具合を
        // UI に波及させない（NFR-2 と同じ思想）。
      }
    };

    source.addEventListener("hello", () => {
      setConnected(true);
    });

    source.addEventListener("restore", (event) => {
      applyRawEvent((event as MessageEvent<string>).data);
    });

    source.onopen = () => {
      setConnected(true);
    };

    source.onerror = () => {
      setConnected(false);
    };

    source.onmessage = (event) => {
      applyRawEvent(event.data);
    };

    const pruneInterval = setInterval(() => {
      state.prune(Date.now());
    }, PRUNE_INTERVAL_MS);

    return () => {
      disposed = true;
      source.close();
      rendererHandle?.stop();
      sceneRef.current?.dispose();
      sceneRef.current = null;
      clearInterval(pruneInterval);
      unsubscribe();
    };
  }, []);

  return (
    <main style={{ maxWidth: 1024, margin: "0 auto", padding: 16 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: PANEL_BG,
          border: `2px solid ${PANEL_BORDER}`,
          boxShadow: HARD_SHADOW,
          padding: "12px 16px",
          marginBottom: 16,
        }}
      >
        <span
          style={{
            backgroundColor: ACCENT_PRIMARY,
            color: PANEL_BG,
            fontWeight: "bold",
            padding: "4px 10px",
            border: `2px solid ${PANEL_BORDER}`,
            boxShadow: "2px 2px 0 #000",
          }}
        >
          AI VIRTUAL OFFICE
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ color: connected ? ACCENT_ACTION : TEXT_SECONDARY }}>
            {connected ? "●" : "○"} {connected ? "connected" : "disconnected"}
          </span>
          <span style={{ color: TEXT_PRIMARY }}>セッション: {sessionCount}</span>
        </div>
      </header>

      <div
        style={{
          backgroundColor: PANEL_BG,
          border: `2px solid ${PANEL_BORDER}`,
          boxShadow: HARD_SHADOW,
          padding: 8,
          display: "inline-block",
        }}
      >
        <canvas ref={canvasRef} width={960} height={480} />
      </div>

      <footer style={{ marginTop: 16, fontSize: 12, color: TEXT_SECONDARY }}>
        ピクセル素材: M0 は未使用（プリミティブ描画のみ）。素材採用時に出典を表記。
      </footer>
    </main>
  );
}
