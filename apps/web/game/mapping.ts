import type { CharacterState } from "@ai-office/protocol";

/**
 * ツール名からキャラクター状態への純粋関数マッピング。
 * アーキ設計 §7（イベント→キャラ状態マッピング）を正本とする。
 */
export function toolToState(toolName: string | undefined): CharacterState {
  switch (toolName) {
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "type";
    case "Read":
    case "Glob":
    case "Grep":
      return "read";
    case "Bash":
      return "terminal";
    case "WebFetch":
    case "WebSearch":
      return "browsing";
    case "Task":
      return "type";
    default:
      return "thinking";
  }
}
