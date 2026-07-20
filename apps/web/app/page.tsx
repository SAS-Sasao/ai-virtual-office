"use client";

import { useEffect, useRef, useState } from "react";
import { attachDebug } from "../game/debug";
import { OfficeState } from "../game/office-state";
import { OfficeEventSchema } from "@ai-office/protocol";
import { startRenderer } from "../game/renderer";

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

  const [connected, setConnected] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);

  useEffect(() => {
    const state = new OfficeState();
    officeStateRef.current = state;

    attachDebug(state);

    const canvas = canvasRef.current;
    const stopRenderer = canvas ? startRenderer(canvas, state) : () => {};

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
      source.close();
      stopRenderer();
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
