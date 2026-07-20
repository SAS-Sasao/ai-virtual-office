// M0 では OfficeEvent の Zod スキーマ + 型をここに置く。
// M1 で packages/protocol へ抽出し、唯一のスキーマ正本とする予定（他パッケージは
// z.infer による型導出のみを行い、独自に型を再定義しないこと）。
import { z } from "zod";

export const OfficeEventSchema = z.object({
  type: z.enum([
    "session_start",
    "user_prompt",
    "pre_tool",
    "post_tool",
    "notification",
    "stop",
    "subagent_stop",
    "session_end",
  ]),
  sessionId: z.string().min(1),
  toolName: z.string().optional(),
  fileBase: z.string().optional(),
  subagentType: z.string().optional(),
  ts: z.number(),
});

export type OfficeEvent = z.infer<typeof OfficeEventSchema>;

export type CharacterState =
  | "idle"
  | "type"
  | "read"
  | "terminal"
  | "browsing"
  | "thinking"
  | "waiting"
  | "done";
