import { describe, expect, it } from "vitest";
import { CharacterStateSchema } from "@ai-office/protocol";
import { STATE_COLORS, STATE_LABELS } from "./tokens";

describe("STATE_LABELS / STATE_COLORS (M1-4b: セッション一覧・待ちパネルの状態バッジ)", () => {
  it("covers every CharacterState defined by the protocol schema (regression guard for new states)", () => {
    for (const state of CharacterStateSchema.options) {
      expect(STATE_LABELS, `STATE_LABELS is missing "${state}"`).toHaveProperty(state);
      expect(STATE_COLORS, `STATE_COLORS is missing "${state}"`).toHaveProperty(state);
    }
  });

  it("labels waiting as 許可待ち (README 抽出仕様2)", () => {
    expect(STATE_LABELS.waiting).toBe("許可待ち");
  });
});
