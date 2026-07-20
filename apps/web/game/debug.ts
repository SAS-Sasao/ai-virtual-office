import type { OfficeSnapshot, OfficeState } from "./office-state";

declare global {
  interface Window {
    __OFFICE_DEBUG__?: {
      getState: () => OfficeSnapshot;
      waitForIdle: () => Promise<void>;
    };
  }
}

/**
 * Debug State API（NFR-8）を window に取り付ける。dev/test ビルド限定。
 * production では tree-shake されることを前提とするが、その unit 検証は M1 で行う。
 */
export function attachDebug(state: OfficeState): void {
  if (typeof window === "undefined" || process.env.NODE_ENV === "production") {
    return;
  }

  window.__OFFICE_DEBUG__ = {
    getState: () => state.getSnapshot(),
    // TODO(M1): レンダラー/イベントキューの実際の idle 検知に置き換える。
    waitForIdle: () => Promise.resolve(),
  };
}
