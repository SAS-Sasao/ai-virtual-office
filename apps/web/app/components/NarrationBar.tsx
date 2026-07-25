import { ACCENT_WARNING, PANEL_BG, TEXT_PRIMARY } from "./tokens";

export interface NarrationBarProps {
  receptionistName: string;
  narrationText: string;
}

/**
 * 秘書ナレーションバー（canvas 直下）。
 *
 * 【最重要制約・人間承認済み】可視化のみ。承認/停止/報告のような操作ボタンは
 * 一切置かない（v0.2 スコープ外・v0.3 で別途検討）。AC-7 構造的検証の対象:
 * このファイルにイベントハンドラ（onClick 等）を追加しないこと。
 */
export function NarrationBar({ receptionistName, narrationText }: NarrationBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        backgroundColor: PANEL_BG,
        border: `2px solid ${ACCENT_WARNING}`,
        boxShadow: "4px 4px 0 #000",
        padding: "8px 12px",
        marginTop: 8,
        color: TEXT_PRIMARY,
        fontSize: 12,
      }}
    >
      <strong style={{ color: ACCENT_WARNING, flexShrink: 0 }}>{receptionistName}</strong>
      <span>{narrationText}</span>
    </div>
  );
}
