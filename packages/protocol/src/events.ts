// 本ファイルが OfficeEvent の唯一の正本。他パッケージは z.infer で型導出のみ行い
// 再定義しないこと。
//
// org / dept / role は M1-3（帰属推定）で追加予定。state はイベントに持たせない
// （mapping.toolToState で導出する派生値であり、OfficeEvent 自体は持たない）。
import { z } from "zod";

/**
 * キャラクターの見た目上の状態。ツール名からの導出（mapping.toolToState）でのみ
 * 生成され、OfficeEvent には含まれない派生値。
 */
export const CharacterStateSchema = z.enum([
  "idle",
  "type",
  "read",
  "terminal",
  "browsing",
  "thinking",
  "waiting",
  "done",
]);

export type CharacterState = z.infer<typeof CharacterStateSchema>;

/**
 * Claude Code hooks イベントを正規化した OfficeEvent。
 *
 * 順序規約: 消費側は `seq` があれば `seq` 昇順、無ければ `ts` 昇順で扱う。
 * `seq` は Relay プロセス内の単調増加カウンタであり、Relay 再起動をまたぐ
 * 単調性は保証しない（永続採番は M1-2 で対応）。
 */
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
  seq: z.number().int().nonnegative().optional(),
});

export type OfficeEvent = z.infer<typeof OfficeEventSchema>;
