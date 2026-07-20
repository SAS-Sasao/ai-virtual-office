import type { OfficeEvent } from "@ai-office/protocol";

export type OfficeEventListener = (ev: OfficeEvent) => void;

interface OfficeEventBus {
  publish(ev: OfficeEvent): void;
  subscribe(fn: OfficeEventListener): () => void;
}

/**
 * dev のホットリロード（Next.js の Fast Refresh / モジュール再評価）を
 * 挟んでも購読者が二重登録・消失しないよう、bus 本体は globalThis に
 * シングルトンとして保持する。
 */
const GLOBAL_KEY = "__aiOfficeEventBus__";

type GlobalWithBus = typeof globalThis & {
  [GLOBAL_KEY]?: {
    listeners: Set<OfficeEventListener>;
  };
};

function getStore(): { listeners: Set<OfficeEventListener> } {
  const g = globalThis as GlobalWithBus;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { listeners: new Set<OfficeEventListener>() };
  }
  return g[GLOBAL_KEY];
}

/**
 * イベントを全購読者へ配信する。個々のリスナーが例外を投げても、
 * 他のリスナーへの配信は継続する（1 つの購読者の不具合が
 * 他の購読者・ingest の応答を巻き込まないようにするため）。
 */
export function publish(ev: OfficeEvent): void {
  const { listeners } = getStore();
  for (const listener of listeners) {
    try {
      listener(ev);
    } catch {
      // リスナーの例外は握り潰し、他リスナーへの配信を継続する。
    }
  }
}

/**
 * イベントを購読する。戻り値の関数を呼ぶと購読を解除する。
 */
export function subscribe(fn: OfficeEventListener): () => void {
  const { listeners } = getStore();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
