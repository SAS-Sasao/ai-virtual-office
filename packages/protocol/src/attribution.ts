// attribution.json（帰属インデックス）の唯一の正本（M1-3）。
//
// 生成側は packages/cc-sier-adapter/src/attribution-index.ts（CC-SIer の masters を
// 読み、この正規化 JSON に変換する）。消費側は packages/relay/src/attribute.ts の
// 汎用 lookup で、attribution.json だけを読み CC-SIer を一切知らない
// （プログレッシブ・ディスクロージャ。アーキ設計 §5・§10.2、FR-4）。
//
// スキーマの正本を protocol に一元化する理由: TypeScript ルール 1「型の正本は
// packages/protocol」に従い、adapter と relay の双方がこの型を再定義せず z.infer で
// 導出するため。
import { z } from "zod";

export const AttributionIndexSchema = z.object({
  version: z.literal(1),
  /** FR-4 規則 1: hook の cwd がこの prefix のいずれかで前方一致すれば org が確定する。 */
  repoPrefixes: z.array(
    z.object({
      prefix: z.string().min(1),
      org: z.string().min(1),
    }),
  ),
  /**
   * FR-4 規則 2: cwd で org が未確定のときのみ、ブランチ名の `{org}/...` プレフィックスを
   * この一覧と照合する。実データでは dormant（ADR-003）だが要件どおり維持する。
   */
  branchOrgs: z.array(z.string().min(1)),
  /** FR-4 規則 3: PreToolUse(Task) の subagent_type から所属部署を特定する（roles.md 由来）。 */
  subagents: z.record(
    z.string(),
    z.object({
      org: z.string().min(1),
      dept: z.string().min(1),
      role: z.string().min(1),
    }),
  ),
  /** FR-4 規則 4 のフォールバック先。組織 ID → 秘書室（dept-secretary）の部署 ID。 */
  receptionDept: z.record(z.string(), z.string().min(1)),
});

export type AttributionIndex = z.infer<typeof AttributionIndexSchema>;
