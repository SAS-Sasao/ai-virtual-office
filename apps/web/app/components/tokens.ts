// UI 表示用デザイントークン（docs/design/ui/README.md 抽出仕様1: v3 ダークネイビー）。
// v2 のウッド調（#141017 / #241a10 / #3a2415）は不採用となったため、
// page.tsx を含む apps/web/app/ 配下の全コンポーネントはこのトークンに統一する。
// CSS フレームワークは導入せず、インラインスタイルから参照する定数のみを置く。
import type { CharacterState } from "@ai-office/protocol";

export const PAGE_BG = "#0b0d18";
export const PANEL_BG = "#12152a";
export const BORDER_COLOR = "#2a3050";
export const DIVIDER_COLOR = "#1a1e36";

export const TEXT_PRIMARY = "#e8eaf6";
export const TEXT_SECONDARY = "#9aa0b8";
export const TEXT_MUTED = "#6a7194";
export const LOG_TEXT = "#c6cbe0";

export const ACCENT_PRIMARY = "#7ef29a"; // ブランドチップ・アクティブタブ・見出し
export const ACCENT_WARNING = "#ffd166"; // 待ちパネル枠・ナレーションバー枠・許可待ちバッジ
export const ACCENT_INFO = "#6be5ff"; // イベントログ見出し・リンク

export const HARD_SHADOW_SM = "2px 2px 0 #000";
export const HARD_SHADOW_LG = "8px 8px 0 #000";

export const FONT_FAMILY = "'DotGothic16', monospace";

// 抽出仕様2: キャラクター状態の表現（8 状態）+ 実装補完の walk/leave（README 注記）。
export const STATE_LABELS: Record<CharacterState, string> = {
  idle: "待機",
  type: "編集",
  read: "読取",
  terminal: "端末",
  browsing: "閲覧",
  thinking: "思考",
  waiting: "許可待ち",
  done: "完了",
  walk: "移動",
  leave: "退出",
};

export const STATE_COLORS: Record<CharacterState, string> = {
  idle: "#9aa0b8",
  type: "#7ef29a",
  read: "#6be5ff",
  terminal: "#c39bff",
  browsing: "#5aa2ff",
  thinking: "#9aa0b8",
  waiting: "#ffd166",
  done: "#ffffff",
  walk: "#9aa0b8",
  leave: "#6a7194",
};
