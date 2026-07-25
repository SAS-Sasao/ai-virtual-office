import type { SessionListRow } from "../lib/session-list";
import { ACCENT_WARNING, DIVIDER_COLOR, PANEL_BG, TEXT_MUTED, TEXT_PRIMARY } from "./tokens";

export interface WaitingPanelProps {
  rows: readonly SessionListRow[];
  /**
   * 「確認」= フォーカスのみ（操作系ではない。要件 §10 / M1-4b スコープ判断）。
   * ここから承認・停止・再開等のミューテーションは一切送信しない。
   */
  onConfirm: (row: SessionListRow) => void;
}

/** サイドバー: 待ちパネル（黄枠で最強調。要件 §10「許可待ちを見逃さない」）。 */
export function WaitingPanel({ rows, onConfirm }: WaitingPanelProps) {
  return (
    <section
      style={{
        border: `2px solid ${ACCENT_WARNING}`,
        backgroundColor: PANEL_BG,
        padding: 8,
        marginBottom: 16,
      }}
    >
      <h2 style={{ fontSize: 12, color: ACCENT_WARNING, margin: "0 0 8px" }}>許可待ち ({rows.length})</h2>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: TEXT_MUTED }}>許可待ち・入力待ちはありません</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <li
              key={row.sessionId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 4px",
                borderBottom: `1px solid ${DIVIDER_COLOR}`,
                fontSize: 12,
                color: TEXT_PRIMARY,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.role} · {row.elapsed}
              </span>
              <button
                type="button"
                onClick={() => onConfirm(row)}
                style={{
                  fontFamily: "inherit",
                  fontSize: 11,
                  cursor: "pointer",
                  padding: "2px 8px",
                  border: `1px solid ${ACCENT_WARNING}`,
                  backgroundColor: "transparent",
                  color: ACCENT_WARNING,
                  flexShrink: 0,
                }}
              >
                確認
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
