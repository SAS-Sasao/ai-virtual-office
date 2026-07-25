import { ACCENT_INFO, LOG_TEXT, TEXT_MUTED } from "./tokens";

export interface EventLogProps {
  /** `formatEventLogLine` 済みの表示行（直近が先頭。M1-4b: 直近 7 件）。 */
  lines: readonly string[];
}

/** サイドバー: イベントログ（直近 7 件・クライアント側リングバッファ）。 */
export function EventLog({ lines }: EventLogProps) {
  return (
    <section>
      <h2 style={{ fontSize: 12, color: ACCENT_INFO, margin: "0 0 8px" }}>イベントログ</h2>
      {lines.length === 0 ? (
        <p style={{ fontSize: 12, color: TEXT_MUTED }}>イベントはまだありません</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 11, color: LOG_TEXT }}>
          {lines.map((line, index) => (
            <li key={index} style={{ padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
