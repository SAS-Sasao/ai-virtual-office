/**
 * `GET /health` が公開する観測統計（receivedCount / lastEventAt）を保持する
 * プロセス内カウンタ。`packages/cli` の `ai-office doctor` が「hooks 経由の
 * イベントが実際に届いているか」を診断するために参照する（M1-2b 設計メモ
 * 「packages/relay — /health の拡張」節）。
 *
 * - 永続化はしない（Relay 再起動でリセットされる。必要になれば seq.ts と
 *   同様の永続化設計を別途行う）
 * - `createServer` の依存として DI 可能にする（seq.ts の createSeqCounter と
 *   同じ設計方針。テストの決定論性のため、生成関数のクロージャに state を
 *   閉じ込め、テストごとに独立したカウンタを作れるようにしている）
 */
export interface StatsCounter {
  /**
   * `POST /hooks/:event` で正規化に成功した（= 実際に forward された）
   * イベントを 1 件記録する。`ts` には呼び出し側の `now()` の戻り値を渡す
   * （時刻源を server.ts の DI と一致させ、テストの決定論性を保つ）。
   */
  record: (ts: number) => void;
  /** 現在の統計スナップショットを返す。副作用は無い（呼んでも値は変わらない）。 */
  snapshot: () => { receivedCount: number; lastEventAt: number | null };
}

/** `StatsCounter` の既定実装を生成する。 */
export function createStatsCounter(): StatsCounter {
  let receivedCount = 0;
  let lastEventAt: number | null = null;

  return {
    record(ts: number): void {
      receivedCount += 1;
      lastEventAt = ts;
    },
    snapshot() {
      return { receivedCount, lastEventAt };
    },
  };
}
