import { FloorTabs, type FloorTabItem } from "./FloorTabs";
import { ACCENT_PRIMARY, ACCENT_WARNING, BORDER_COLOR, HARD_SHADOW_SM, PANEL_BG, TEXT_SECONDARY } from "./tokens";

export interface HeaderProps {
  floors: readonly FloorTabItem[];
  selectedFloorOrg: string | undefined;
  onSelectFloor: (org: string) => void;
  waitingCount: number;
  connected: boolean;
}

/**
 * 共通ヘッダ（ブランド / フロア切替タブ / 許可待ちバッジ / 接続状態）。
 *
 * AC-7 構造的検証の対象: 「バッジ相当のコンポーネント」はこのファイル。
 * フロア切替のクリックハンドラは子の `FloorTabs` 側に閉じ込め、このファイル
 * 自身は一切の onClick 等のイベントハンドラを持たない（バッジは強調表示のみで
 * クリック不可 = 操作系ではなく可視化）。
 */
export function Header({ floors, selectedFloorOrg, onSelectFloor, waitingCount, connected }: HeaderProps) {
  const hasWaiting = waitingCount > 0;

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        backgroundColor: PANEL_BG,
        border: `2px solid ${BORDER_COLOR}`,
        boxShadow: "4px 4px 0 #000",
        padding: "12px 16px",
        marginBottom: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span
          style={{
            backgroundColor: ACCENT_PRIMARY,
            color: PANEL_BG,
            fontWeight: "bold",
            padding: "4px 10px",
            border: `2px solid ${BORDER_COLOR}`,
            boxShadow: HARD_SHADOW_SM,
          }}
        >
          AI VIRTUAL OFFICE
        </span>

        <FloorTabs floors={floors} selectedOrg={selectedFloorOrg} onSelect={onSelectFloor} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span
          aria-live="polite"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            border: `2px solid ${hasWaiting ? ACCENT_WARNING : BORDER_COLOR}`,
            color: hasWaiting ? ACCENT_WARNING : TEXT_SECONDARY,
            animation: hasWaiting ? "office-badge-blink 1.1s steps(2) infinite" : undefined,
          }}
        >
          許可待ち {waitingCount}
        </span>

        <span style={{ color: connected ? ACCENT_PRIMARY : TEXT_SECONDARY }}>
          {connected ? "●" : "○"} {connected ? "connected" : "disconnected"}
        </span>
      </div>

      {/* バッジの blink は JS タイマーではなく CSS keyframes で表現する
          （React state / setInterval を経由しない = ゲーム状態と同じ「高頻度更新を
          React に乗せない」制約に沿う）。 */}
      <style>{`
        @keyframes office-badge-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </header>
  );
}
