import type { CharacterState } from "@ai-office/protocol";
import type { RuntimeLayout } from "./layout-runtime";
import type { Scene } from "./scene";

/**
 * Debug State API（NFR-8）の公開形状。
 * docs/design/loop-engineering-design.md §5.1（決定 1: Debug State API）の型を
 * そのまま実装する（apps/web の dev/test ビルド限定で window に取り付ける）。
 */
export interface DebugCharacterView {
  id: string;
  role: string;
  dept: string;
  state: CharacterState;
  x: number;
  y: number;
  sessionId: string | null;
}

export interface DebugFloorView {
  org: string;
  rooms: string[];
}

export interface DebugState {
  characters: DebugCharacterView[];
  floors: DebugFloorView[];
  /** 待ちパネル件数（state === "waiting" のキャラ数）。 */
  pendingNotifications: number;
  /** ゲーム内 tick（決定論検証用）。scene.getClock() をそのまま返す。 */
  clock: number;
}

declare global {
  interface Window {
    __OFFICE_DEBUG__?: {
      getState: () => DebugState;
      waitForIdle: () => Promise<void>;
    };
  }
}

/** Scene の実行時キャラ一覧を Debug State API の形へ写像する。 */
export function buildDebugState(scene: Scene, runtimeLayout: RuntimeLayout): DebugState {
  const characters: DebugCharacterView[] = scene.getRuntimeCharacters().map((c) => ({
    id: c.id,
    role: c.role,
    dept: c.dept,
    state: c.state,
    x: c.x,
    y: c.y,
    sessionId: c.sessionId,
  }));

  const floors: DebugFloorView[] = runtimeLayout.floors.map((f) => ({
    org: f.floor.org,
    rooms: f.floor.rooms.map((r) => r.id),
  }));

  // M1-4b AC-5: OfficeState の waiting セッション数を唯一のソースとする（scene が
  // syncFromOffice のたびに記録する）。RuntimeCharacter.state（walk/leave 中は本来の
  // 状態が onArriveState に退避されている）に依存すると、visitor が受付へ歩いている
  // 間だけ pendingNotifications が実際のセッション数と乖離する（歩行遅延ドリフト）。
  const pendingNotifications = scene.getWaitingSessionCount();

  return { characters, floors, pendingNotifications, clock: scene.getClock() };
}

/**
 * scene.isIdle()（「walk/leave が 0 かつ未消化パス 0」。装飾ループの bob/blink は
 * 含めない）を満たすまで待つ。`schedule` は再チェックのタイミングを外部から注入できる
 * ようにするための DI（既定は `setTimeout(cb, 0)`。sleep は使わない）。
 */
export function waitForSceneIdle(
  scene: Scene,
  schedule: (callback: () => void) => void = (callback) => setTimeout(callback, 0),
): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (scene.isIdle()) {
        resolve();
        return;
      }
      schedule(check);
    };
    check();
  });
}

/**
 * Debug State API（NFR-8）を window に取り付ける。dev/test ビルド限定。
 * production では tree-shake されることを前提とする。
 */
export function attachDebug(scene: Scene, runtimeLayout: RuntimeLayout): void {
  if (typeof window === "undefined" || process.env.NODE_ENV === "production") {
    return;
  }

  window.__OFFICE_DEBUG__ = {
    getState: () => buildDebugState(scene, runtimeLayout),
    waitForIdle: () => waitForSceneIdle(scene),
  };
}
