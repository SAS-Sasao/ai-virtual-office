// 本ファイルが OfficeEvent の唯一の正本。他パッケージは z.infer で型導出のみ行い
// 再定義しないこと。
//
// org / dept / role は M1-3（帰属推定）で追加された FR-4 の出力（すべて optional）。
// state はイベントに持たせない（mapping.toolToState で導出する派生値であり、
// OfficeEvent 自体は持たない）。
import { z } from "zod";

/**
 * キャラクターの見た目上の状態。OfficeEvent には含まれない派生値。
 *
 * - `idle` 〜 `done`（8 種）: ツール名からの導出（mapping.toolToState）で生成される。
 * - `walk` / `leave`（M1-4a 追加）: **移動由来**の状態であり、`mapping.toolToState`
 *   は設定しない。`apps/web/game` の状態機械（scene.ts）だけが、入退室・自席への
 *   往復などキャラクターの歩行遷移を表現するために設定する。
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
  "walk",
  "leave",
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
  org: z.string().optional(),
  dept: z.string().optional(),
  role: z.string().optional(),
  /**
   * ユーザー/サブエージェントへの依頼文本文（ADR-007 二層化モデルの例外）。
   *
   * NFR-4 の blanket whitelist（本文系は一切保存しない）に対する唯一の例外。
   * ローカル配信経路（hooks → Relay → ローカル web）でのみ保持してよい値であり、
   * クラウド転送境界では `packages/relay/src/forward.ts` の
   * `stripCloudSensitive` で必ず取り除くこと。抽出元は Relay の正規化段階
   * （`packages/relay/src/normalize.ts`）で UserPromptSubmit の `prompt` と
   * Task ツールの `tool_input.prompt` のみに厳しく限定されている。
   */
  requestText: z.string().optional(),
});

export type OfficeEvent = z.infer<typeof OfficeEventSchema>;
