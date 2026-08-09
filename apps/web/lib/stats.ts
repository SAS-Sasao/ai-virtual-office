/**
 * ingest の観測統計（accepted / dropped 理由別）を保持するプロセス内カウンタ。
 *
 * `packages/relay/src/stats.ts`（`StatsCounter` + `createStatsCounter()` の
 * closure-DI パターン）を web 版として写経したもの。relay 側は `/health` が
 * `receivedCount`/`lastEventAt` を返すが、web 側は ingest の 2 つの無言ドロップ
 * 経路（schema 不一致・JSON parse 不能）を観測可能にすることが目的のため、
 * `acceptedCount` / `dropped`（理由別）を持つ形に対応させている
 * （バックエンド堅牢化サイクル2 設計メモ「修正1（ログ）/ 修正2（カウンタ）」）。
 *
 * - 永続化はしない（プロセス再起動でリセットされる）
 * - `createStatsCounter()` は DI 可能な純カウンタ（テストごとに独立したインスタンスを
 *   作れる）。`getStats()` はそれを `globalThis` にシングルトンとして保持する
 *   getter（`lib/bus.ts` / `db/client.ts` と同じ dev ホットリロード対策パターン）。
 */

export type DropReason = "schema" | "unparseable";

export interface StatsSnapshot {
  acceptedCount: number;
  droppedCount: number;
  dropped: Record<DropReason, number>;
}

export interface StatsCounter {
  /** ingest が正規化済み OfficeEvent を受理した（publish した）ことを 1 件記録する。 */
  recordAccepted: () => void;
  /** ingest が入力を無言ドロップせず観測可能な形で 1 件破棄したことを記録する。 */
  recordDropped: (reason: DropReason) => void;
  /** 現在の統計スナップショットを返す。副作用は無い。 */
  snapshot: () => StatsSnapshot;
}

/** `StatsCounter` の既定実装を生成する（DI 可能。テストごとに独立したインスタンスを作れる）。 */
export function createStatsCounter(): StatsCounter {
  let acceptedCount = 0;
  const dropped: Record<DropReason, number> = { schema: 0, unparseable: 0 };

  return {
    recordAccepted(): void {
      acceptedCount += 1;
    },
    recordDropped(reason: DropReason): void {
      dropped[reason] += 1;
    },
    snapshot(): StatsSnapshot {
      return {
        acceptedCount,
        droppedCount: dropped.schema + dropped.unparseable,
        dropped: { ...dropped },
      };
    },
  };
}

/**
 * dev のホットリロード（Next.js の Fast Refresh / モジュール再評価）を
 * 挟んでもカウンタが再生成・リセットされないよう、`globalThis` に
 * シングルトンとして保持する（`lib/bus.ts` / `db/client.ts` と同じパターン）。
 */
const GLOBAL_KEY = "__aiOfficeStats__";

type GlobalWithStats = typeof globalThis & {
  [GLOBAL_KEY]?: StatsCounter;
};

/** プロセス内シングルトンとして統計カウンタを取得する。 */
export function getStats(): StatsCounter {
  const g = globalThis as GlobalWithStats;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = createStatsCounter();
  }
  return g[GLOBAL_KEY];
}

/** テスト専用: globalThis に保持されたシングルトンをリセットする。 */
export function resetStatsSingletonForTests(): void {
  const g = globalThis as GlobalWithStats;
  delete g[GLOBAL_KEY];
}
