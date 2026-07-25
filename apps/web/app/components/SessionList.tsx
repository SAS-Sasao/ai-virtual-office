import type { SessionListRow } from "../lib/session-list";
import { BORDER_COLOR, DIVIDER_COLOR, PAGE_BG, STATE_COLORS, STATE_LABELS, TEXT_MUTED, TEXT_PRIMARY, TEXT_SECONDARY } from "./tokens";

export interface SessionListProps {
  rows: readonly SessionListRow[];
  focusedSessionId: string | null;
  /** 一覧クリック → フォーカス + 該当フロアへの切替（page.tsx 側の責務）。 */
  onSelect: (row: SessionListRow) => void;
}

/** サイドバー: セッション一覧（`OfficeState.subscribe` の低頻度通知で更新）。 */
export function SessionList({ rows, focusedSessionId, onSelect }: SessionListProps) {
  return (
    <section>
      <h2 style={{ fontSize: 12, color: TEXT_SECONDARY, margin: "0 0 8px" }}>セッション一覧 ({rows.length})</h2>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: TEXT_MUTED }}>アクティブなセッションはありません</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row) => {
            const focused = row.sessionId === focusedSessionId;
            return (
              <li key={row.sessionId} style={{ borderBottom: `1px solid ${DIVIDER_COLOR}` }}>
                <button
                  type="button"
                  onClick={() => onSelect(row)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    fontFamily: "inherit",
                    fontSize: 12,
                    cursor: "pointer",
                    padding: "6px 4px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    backgroundColor: focused ? PAGE_BG : "transparent",
                    border: focused ? `1px solid ${BORDER_COLOR}` : "1px solid transparent",
                    color: TEXT_PRIMARY,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.role}</span>
                  <span style={{ color: STATE_COLORS[row.state], flexShrink: 0 }}>{STATE_LABELS[row.state]}</span>
                  <span style={{ color: TEXT_MUTED, flexShrink: 0 }}>{row.elapsed}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
