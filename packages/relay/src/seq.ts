/**
 * Relay プロセス内で単調増加する seq を発行するカウンタを生成する。
 *
 * グローバル変数を使わず、生成関数のクロージャに state を閉じ込めることで、
 * テストごとに独立したカウンタを作れるようにしている（テスト間の状態漏れ防止）。
 *
 * 順序規約（packages/protocol の OfficeEventSchema doc comment 参照）: この seq は
 * Relay プロセス内でのみ単調増加を保証する。Relay 再起動をまたぐ単調性は
 * 保証しない（永続採番は M1-2 で対応予定）。
 */
export function createSeqCounter(start = 0): () => number {
  let next = start;
  return (): number => {
    const current = next;
    next += 1;
    return current;
  };
}
