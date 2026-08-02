"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { OfficeEventSchema, type Character, type OfficeEvent, type OfficeLayout } from "@ai-office/protocol";
import { EventLog } from "./components/EventLog";
import { Header } from "./components/Header";
import type { FloorTabItem } from "./components/FloorTabs";
import { NarrationBar } from "./components/NarrationBar";
import { SessionList } from "./components/SessionList";
import { WaitingPanel } from "./components/WaitingPanel";
import { BORDER_COLOR, HARD_SHADOW_LG, PANEL_BG, TEXT_SECONDARY } from "./components/tokens";
import { attachDebug } from "../game/debug";
import { buildRuntimeLayout } from "../game/layout-runtime";
import { OfficeState, type SessionCharacter } from "../game/office-state";
import { startRenderer, type RendererHandle } from "../game/renderer";
import { Scene } from "../game/scene";
import { EventLogBuffer, formatEventLogLine } from "./lib/event-log";
import { buildNarrationText, resolveReceptionistName } from "./lib/narration";
import { buildSessionListRows, buildWaitingRows, countWaiting, type SessionListRow } from "./lib/session-list";

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

/**
 * 本番のスプライトシート画像ローダ（renderer へ opt-in で注入する）。
 * `new Image()`/DOM への依存はこの React 側（OfficeView）に閉じ込め、game/ 層には
 * 持ち込まない（NFR-7 = game/ 非依存維持）。renderer が渡す `src`（org のテーマ別
 * PNG パス。M2-1c・`SPRITE_SHEET_SRC`）をロードし、成功で `<img>` を解決、失敗で
 * reject する（renderer 側は reject をそのテーマの生成スプライト据え置きとして扱う）。
 */
function loadSpriteImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

const PRUNE_INTERVAL_MS = 30_000;
/**
 * 経過（セッション一覧・待ちパネル）の再描画間隔。1 秒刻みの setInterval で
 * React を毎秒更新することは禁止(M1-4b 設計メモ「経過時間の扱い」。粒度は
 * 「1 分未満 / N 分」で十分なため 10 秒間隔の低頻度 re-render にとどめる）。
 */
const ELAPSED_TICK_INTERVAL_MS = 10_000;

export interface LayoutMeta {
  floors: FloorTabItem[];
  receptionistName: string;
}

export const EMPTY_LAYOUT_META: LayoutMeta = { floors: [], receptionistName: "オフィス" };

export interface OfficeViewProps {
  /**
   * サーバコンポーネント（page.tsx）が `loadOfficeLayoutData` で読み込んだ初期値。
   * ヘッダのフロアタブ・ナレーションバーの受付名を **初回 HTML から** 表示するための
   * SSR シード（curl だけで検証できるようにするための最適化）。ゲーム本体（Scene /
   * renderer）は引き続きこの effect 内で `/api/layout` を自前 fetch して構築する
   * （既存の client-fetch パターンを変えない。このシードはヘッダ表示専用）。
   */
  initialLayoutMeta: LayoutMeta;
}

/**
 * オフィスビュー本体（M1-4b: フロア切替・セッション一覧・待ちパネル・ホバー詳細・
 * 秘書ナレーション表示）。
 *
 * 最重要制約: ゲーム状態（セッション・キャラの位置や状態、ホバー、フォーカス
 * リングのアニメーション）は React state に置かない。OfficeState / Scene /
 * RendererHandle は useRef で保持し、描画は game/renderer.ts の
 * requestAnimationFrame ループに委ねる。ポインタ座標は `scene.setPointer` を
 * 直接呼ぶだけで React state を経由しない。
 *
 * React state に置くのは UI 表示専用の低頻度な値のみ:
 * `connected` / `sessions`（OfficeState.subscribe のスナップショット） /
 * `layoutMeta`（フロアタブ・受付名。SSR シードを初期値に、layout 取得完了時に
 * 更新） / `selectedFloorOrg` / `focusedSessionId`（選択 UI の状態） /
 * `now`（経過表示用、10 秒間隔） / `eventLog`（イベントログ表示用の直近 7 件）。
 */
export function OfficeView({ initialLayoutMeta }: OfficeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const officeStateRef = useRef<OfficeState | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const rendererHandleRef = useRef<RendererHandle | null>(null);

  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<SessionCharacter[]>([]);
  const [layoutMeta, setLayoutMeta] = useState<LayoutMeta>(initialLayoutMeta);
  const [selectedFloorOrg, setSelectedFloorOrg] = useState<string | undefined>(() => initialLayoutMeta.floors[0]?.org);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [eventLog, setEventLog] = useState<OfficeEvent[]>([]);

  useEffect(() => {
    let disposed = false;

    const state = new OfficeState();
    officeStateRef.current = state;
    // イベントログのリングバッファは OfficeState と同じ寿命（この effect 内）で
    // 作り直す。OfficeState は集約済みセッション状態のみを保持し個々の生イベント
    // 履歴を持たないため、SSE を受け取ったこの effect 側で個別に蓄積する。
    const eventLogBuffer = new EventLogBuffer();

    const fastMode = readFastModeFlag(window.location.search);

    // 初期化は /api/layout の fetch 完了を待つ非同期処理だが、SSE 購読・prune
    // タイマー・接続表示は（layout の有無に関わらず）即座に開始する。scene/
    // renderer はレイアウト取得後に組み立て、アンマウント時は disposed フラグで
    // 後始末の二重実行・アンマウント後の起動を防ぐ。ヘッダのフロアタブ・受付名は
    // props の SSR シード（initialLayoutMeta）で既に表示済みだが、layout が
    // fetch 後に変わっている可能性もゼロではないため、ここでも再計算して
    // 一致させる（不一致時は fetch 結果を正とする）。
    const init = async (): Promise<void> => {
      const { layout, characters } = await fetchLayoutData();
      if (disposed) return;

      const runtimeLayout = buildRuntimeLayout(layout, characters);
      const scene = new Scene(runtimeLayout, characters, state, { fastMode });
      sceneRef.current = scene;

      attachDebug(scene, runtimeLayout);

      const floors: FloorTabItem[] = runtimeLayout.floors.map((f) => ({ org: f.floor.org, label: f.floor.label }));
      setLayoutMeta({ floors, receptionistName: resolveReceptionistName(characters) });
      setSelectedFloorOrg((current) => current ?? floors[0]?.org);

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

        rendererHandleRef.current = startRenderer(canvas, scene, runtimeLayout, {
          canvasFactory: (width, height) => {
            const offscreen = document.createElement("canvas");
            offscreen.width = width;
            offscreen.height = height;
            return offscreen;
          },
          // ADR-005・M2-1c: 自作 PNG スプライトシート（org のテーマ別。office/rpg）を
          // opt-in で注入する。未ロード/失敗時は renderer がそのテーマの生成スプライトへ
          // フォールバックする。
          spriteImageLoader: loadSpriteImage,
        });
      }
    };

    void init();

    const unsubscribe = state.subscribe(() => {
      setSessions(state.getSnapshot().sessions);
    });

    const source = new EventSource("/api/stream");

    // restore（接続直後の直近状態復元）と live（通常配信）は同じ検証・適用経路
    // を通す。順序防御（seq/ts 比較）は state.applyEvent 側（office-state.ts）
    // に一本化されているため、ここでは単純に parse → applyEvent するだけでよい。
    // 併せてイベントログのリングバッファへも push する（サイドバー表示用）。
    const applyRawEvent = (rawData: string): void => {
      try {
        const parsed = OfficeEventSchema.parse(JSON.parse(rawData));
        state.applyEvent(parsed);
        eventLogBuffer.push(parsed);
        setEventLog(eventLogBuffer.getItems());
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

    const elapsedTickInterval = setInterval(() => {
      setNow(Date.now());
    }, ELAPSED_TICK_INTERVAL_MS);

    return () => {
      disposed = true;
      source.close();
      rendererHandleRef.current?.stop();
      rendererHandleRef.current = null;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      clearInterval(pruneInterval);
      clearInterval(elapsedTickInterval);
      unsubscribe();
    };
  }, []);

  /** フロアタブ・セッション一覧クリック共通: scene/renderer のフロアを切り替える。 */
  const handleSelectFloor = useCallback((org: string) => {
    sceneRef.current?.setFloor(org);
    rendererHandleRef.current?.setFloor(org);
    setSelectedFloorOrg(org);
  }, []);

  /**
   * セッション一覧クリック・待ちパネルの「確認」共通ハンドラ。
   * `scene.focusSessionId` によるフォーカスのみで、承認/停止等の操作は行わない
   * （AC-7: 待ちパネルの「確認」= focus のみは操作系に該当しない）。
   */
  const handleSelectSession = useCallback(
    (row: SessionListRow) => {
      sceneRef.current?.focusSessionId(row.sessionId);
      setFocusedSessionId(row.sessionId);
      if (row.org) {
        handleSelectFloor(row.org);
      }
    },
    [handleSelectFloor],
  );

  // ポインタ結線: 座標変換とヒットテストは scene.setPointer 内で完結する
  // （React state を経由しない。ホバーカードの描画は renderer が担当）。
  const handlePointerMove = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    if (!canvas || !scene) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    scene.setPointer((event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY);
  }, []);

  const handlePointerLeave = useCallback(() => {
    sceneRef.current?.setPointer(null, null);
  }, []);

  const sessionRows = useMemo(() => buildSessionListRows(sessions, now), [sessions, now]);
  const waitingRows = useMemo(() => buildWaitingRows(sessions, now), [sessions, now]);
  // バッジ・待ちパネル・pendingNotifications（Debug State API）はいずれも
  // OfficeState の waiting セッション数（同じ述語）から導出され、常に一致する
  // （M1-4b AC-5）。
  const waitingCount = useMemo(() => countWaiting(sessions), [sessions]);
  const eventLines = useMemo(() => eventLog.map(formatEventLogLine), [eventLog]);
  const narrationText = useMemo(() => buildNarrationText(eventLog[0] ?? null), [eventLog]);

  return (
    <main style={{ maxWidth: 1280, margin: "0 auto", padding: 16 }}>
      <Header
        floors={layoutMeta.floors}
        selectedFloorOrg={selectedFloorOrg}
        onSelectFloor={handleSelectFloor}
        waitingCount={waitingCount}
        connected={connected}
      />

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 auto" }}>
          <div
            style={{
              backgroundColor: PANEL_BG,
              border: `2px solid ${BORDER_COLOR}`,
              boxShadow: HARD_SHADOW_LG,
              padding: 8,
              display: "inline-block",
            }}
          >
            <canvas
              ref={canvasRef}
              width={960}
              height={480}
              onMouseMove={handlePointerMove}
              onMouseLeave={handlePointerLeave}
            />
          </div>

          <NarrationBar receptionistName={layoutMeta.receptionistName} narrationText={narrationText} />
        </div>

        <aside style={{ flex: "1 1 320px", minWidth: 280, display: "flex", flexDirection: "column", gap: 16 }}>
          <WaitingPanel rows={waitingRows} onConfirm={handleSelectSession} />
          <SessionList rows={sessionRows} focusedSessionId={focusedSessionId} onSelect={handleSelectSession} />
          <EventLog lines={eventLines} />
        </aside>
      </div>

      <footer style={{ marginTop: 16, fontSize: 12, color: TEXT_SECONDARY }}>
        キャラクター素材: 作 プロジェクトオーナー（プロジェクトオリジナル）
      </footer>
    </main>
  );
}
