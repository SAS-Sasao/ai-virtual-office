import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerType } from "@hono/node-server";
import {
  createRelayRuntime,
  parseArgs,
  validatePort,
  type RelayRuntimeDeps,
} from "./cli.js";

/**
 * `.on`/`close` のみを実装した偽サーバ。`deps.serve` の戻り値として使う。
 * `on` の呼び出しはすべて記録し、テストから任意のタイミングでハンドラを
 * 手動発火できるようにする（AC-4: 実 :4100 バインドなしで EADDRINUSE 経路を検証）。
 */
function makeFakeServer() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const closeCalls: Array<() => void> = [];
  const fakeServer = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return fakeServer;
    }),
    close: vi.fn((callback: () => void) => {
      closeCalls.push(callback);
      // デフォルトでは即座に close 完了とする（テストごとに上書き可能）。
      callback();
      return fakeServer;
    }),
  };
  return {
    server: fakeServer as unknown as ServerType,
    fireEvent(event: string, ...args: unknown[]): void {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
    closeCalls,
  };
}

/**
 * `deps.setTimeout` の偽実装。実時間を進めず、登録された (fn, ms) を記録するのみ。
 * `.unref` が呼ばれたかどうかも記録できる。
 */
function makeFakeTimer() {
  const scheduled: Array<{ fn: () => void; ms: number; unreffed: boolean }> = [];
  const fakeSetTimeout = vi.fn((fn: () => void, ms: number) => {
    const entry = { fn, ms, unreffed: false };
    scheduled.push(entry);
    return {
      unref: () => {
        entry.unreffed = true;
      },
    };
  });
  return { fakeSetTimeout, scheduled };
}

function makeFakeSignals() {
  const handlers = new Map<string, Array<() => void>>();
  const onSignal = vi.fn((signal: string, handler: () => void) => {
    const list = handlers.get(signal) ?? [];
    list.push(handler);
    handlers.set(signal, list);
  });
  return {
    onSignal,
    fire(signal: string): void {
      for (const handler of handlers.get(signal) ?? []) {
        handler();
      }
    },
  };
}

function makeDeps(overrides: Partial<RelayRuntimeDeps> = {}): {
  deps: RelayRuntimeDeps;
  exit: ReturnType<typeof vi.fn>;
  fakeServer: ReturnType<typeof makeFakeServer>;
  serveFn: ReturnType<typeof vi.fn>;
} {
  const fakeServer = makeFakeServer();
  const exit = vi.fn();
  const serveFn = vi.fn((_options: unknown, listener?: (info: { port: number }) => void) => {
    listener?.({ port: 4100 });
    return fakeServer.server;
  });

  const deps: RelayRuntimeDeps = {
    argv: [],
    env: {},
    serve: serveFn as unknown as RelayRuntimeDeps["serve"],
    exit,
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as { unref?: () => void },
    onSignal: () => {},
    ...overrides,
  };

  return { deps, exit, fakeServer, serveFn };
}

describe("parseArgs", () => {
  it("--port / --forward / --attribution を読み取る", () => {
    expect(parseArgs(["--port", "5000", "--forward", "http://x", "--attribution", "/p.json"])).toEqual({
      port: 5000,
      forward: "http://x",
      attribution: "/p.json",
    });
  });

  it("未知の引数は無視する", () => {
    expect(parseArgs(["--unknown", "value"])).toEqual({});
  });

  it("値が無い --port は無視される", () => {
    expect(parseArgs(["--port"])).toEqual({});
  });

  it("引数無しなら空オブジェクトを返す", () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe("validatePort (AC-5)", () => {
  it.each([1, 80, 4100, 65535])("有効なポート %s はそのまま返す", (port) => {
    expect(validatePort(port)).toBe(port);
  });

  it("0 はエフェメラルポートとして許容する（verify.sh の --port 0 依存を壊さない）", () => {
    expect(validatePort(0)).toBe(0);
  });

  it("数値文字列も受け付ける", () => {
    expect(validatePort("4100")).toBe(4100);
  });

  it.each(["abc", NaN, -1, 65536, 1.5, "", undefined, null])(
    "不正な値 %s は throw する",
    (raw) => {
      expect(() => validatePort(raw)).toThrow();
    },
  );
});

describe("createRelayRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("正常系: serve を既定ポート(4100)で呼び出し、bind 成功メッセージを出す", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps, serveFn, exit } = makeDeps({ argv: [] });

    createRelayRuntime(deps);

    expect(serveFn).toHaveBeenCalledTimes(1);
    const [options] = serveFn.mock.calls[0] as [{ port: number }];
    expect(options.port).toBe(4100);
    expect(exit).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("relay listening on port"));
  });

  it("--port 0 をそのまま serve に渡す（ephemeral、verify.sh 依存）", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps, serveFn } = makeDeps({ argv: ["--port", "0"] });

    createRelayRuntime(deps);

    const [options] = serveFn.mock.calls[0] as [{ port: number }];
    expect(options.port).toBe(0);
  });

  describe("AC-4: ポート bind 失敗 (EADDRINUSE)", () => {
    it("EADDRINUSE エラーで明示メッセージを出し exit(1) する（uncaught に昇格させない）", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { deps, exit, fakeServer } = makeDeps();

      createRelayRuntime(deps);
      const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
      fakeServer.fireEvent("error", err);

      expect(exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
      const message = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toContain("EADDRINUSE");
    });

    it("EADDRINUSE 以外のサーバエラーでも exit(1) する（プロセスをブロック/クラッシュさせない）", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { deps, exit, fakeServer } = makeDeps();

      createRelayRuntime(deps);
      fakeServer.fireEvent("error", new Error("something else"));

      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe("AC-5: 不正なポート値", () => {
    it("--port abc は明示メッセージ + exit(1) し、serve は呼ばれない", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { deps, exit, serveFn } = makeDeps({ argv: ["--port", "abc"] });

      createRelayRuntime(deps);

      expect(exit).toHaveBeenCalledWith(1);
      expect(serveFn).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it("env の AI_OFFICE_RELAY_PORT が NaN 相当のときも exit(1) する", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { deps, exit, serveFn } = makeDeps({ env: { AI_OFFICE_RELAY_PORT: "not-a-number" } });

      createRelayRuntime(deps);

      expect(exit).toHaveBeenCalledWith(1);
      expect(serveFn).not.toHaveBeenCalled();
    });

    it("範囲外のポート(--port 70000)も exit(1) する", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { deps, exit, serveFn } = makeDeps({ argv: ["--port", "70000"] });

      createRelayRuntime(deps);

      expect(exit).toHaveBeenCalledWith(1);
      expect(serveFn).not.toHaveBeenCalled();
    });
  });

  describe("AC-6: graceful shutdown", () => {
    it("SIGINT で server.close() を呼び、完了後 exit(0) する", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const timer = makeFakeTimer();
      const signals = makeFakeSignals();
      const { deps, exit, fakeServer } = makeDeps({
        setTimeout: timer.fakeSetTimeout as unknown as RelayRuntimeDeps["setTimeout"],
        onSignal: signals.onSignal as unknown as RelayRuntimeDeps["onSignal"],
      });

      createRelayRuntime(deps);
      signals.fire("SIGINT");

      expect(fakeServer.closeCalls).toHaveLength(1);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it("shutdown 開始時に強制終了ガード(setTimeout)を .unref() 付きで仕掛ける", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const timer = makeFakeTimer();
      const signals = makeFakeSignals();
      const { deps } = makeDeps({
        setTimeout: timer.fakeSetTimeout as unknown as RelayRuntimeDeps["setTimeout"],
        onSignal: signals.onSignal as unknown as RelayRuntimeDeps["onSignal"],
      });

      createRelayRuntime(deps);
      signals.fire("SIGTERM");

      expect(timer.scheduled).toHaveLength(1);
      expect(timer.scheduled[0].unreffed).toBe(true);
    });

    it("close() がコールバックを一切呼ばずハングしても、強制終了ガードが exit(0) する", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const timer = makeFakeTimer();
      const signals = makeFakeSignals();
      const { deps, exit } = makeDeps({
        setTimeout: timer.fakeSetTimeout as unknown as RelayRuntimeDeps["setTimeout"],
        onSignal: signals.onSignal as unknown as RelayRuntimeDeps["onSignal"],
      });
      // close() が完了コールバックを呼ばない(ハング)偽サーバに差し替える。
      const hangingServer = {
        on: vi.fn(() => hangingServer),
        close: vi.fn(() => hangingServer),
      };
      const serveFn = vi.fn((_o: unknown, listener?: (info: { port: number }) => void) => {
        listener?.({ port: 4100 });
        return hangingServer as unknown as ServerType;
      });
      deps.serve = serveFn as unknown as RelayRuntimeDeps["serve"];

      createRelayRuntime(deps);
      signals.fire("SIGINT");

      // close() 単体では exit(0) はまだ呼ばれていない（コールバックが発火していないため）。
      expect(exit).not.toHaveBeenCalled();

      // 強制終了ガードのタイマーを手動発火する。
      expect(timer.scheduled).toHaveLength(1);
      timer.scheduled[0].fn();

      expect(exit).toHaveBeenCalledWith(0);
    });

    it("shutdown 開始時に再送バッファが空（size()===0）なら warn しない", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const timer = makeFakeTimer();
      const signals = makeFakeSignals();
      const { deps } = makeDeps({
        setTimeout: timer.fakeSetTimeout as unknown as RelayRuntimeDeps["setTimeout"],
        onSignal: signals.onSignal as unknown as RelayRuntimeDeps["onSignal"],
        buffer: {
          send: vi.fn(async () => {}),
          size: () => 0,
        },
      });

      createRelayRuntime(deps);
      signals.fire("SIGINT");

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("pending"));
    });

    it("shutdown 開始時に再送バッファが滞留していれば（size()>0）滞留件数付きで warn する", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const timer = makeFakeTimer();
      const signals = makeFakeSignals();
      // `RelayRuntimeDeps.buffer` に size()>0 を返す偽 RetryBuffer を注入することで、
      // createRelayRuntime 内部生成のバッファに頼らず shutdown の滞留 warn（AC-6 正分岐）
      // を決定論的に検証する（Phase 3 レビュー低 finding 対応: 従来は buffer が
      // 内部生成のため注入不能で、この正分岐が未テストだった）。
      const { deps } = makeDeps({
        setTimeout: timer.fakeSetTimeout as unknown as RelayRuntimeDeps["setTimeout"],
        onSignal: signals.onSignal as unknown as RelayRuntimeDeps["onSignal"],
        buffer: {
          send: vi.fn(async () => {}),
          size: () => 3,
        },
      });

      createRelayRuntime(deps);
      signals.fire("SIGINT");

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("3"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("pending"));
    });

    it("SIGINT/SIGTERM の再入ガード: 2 度目の signal は close を待たず即 exit する", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const timer = makeFakeTimer();
      const signals = makeFakeSignals();
      // close() のコールバックを保持するだけで即座には呼ばない偽サーバにする
      // ことで「1 度目の shutdown がまだ完了していない」状態を作る。
      const pendingCallbacks: Array<() => void> = [];
      const pendingServer = {
        on: vi.fn(() => pendingServer),
        close: vi.fn((cb: () => void) => {
          pendingCallbacks.push(cb);
          return pendingServer;
        }),
      };
      const serveFn = vi.fn((_o: unknown, listener?: (info: { port: number }) => void) => {
        listener?.({ port: 4100 });
        return pendingServer as unknown as ServerType;
      });
      const { deps, exit } = makeDeps({
        setTimeout: timer.fakeSetTimeout as unknown as RelayRuntimeDeps["setTimeout"],
        onSignal: signals.onSignal as unknown as RelayRuntimeDeps["onSignal"],
      });
      deps.serve = serveFn as unknown as RelayRuntimeDeps["serve"];

      createRelayRuntime(deps);
      signals.fire("SIGINT");
      expect(exit).not.toHaveBeenCalled();
      expect(pendingServer.close).toHaveBeenCalledTimes(1);

      signals.fire("SIGINT");
      // 2 度目は close() を再度呼ばず、即 exit する。
      expect(pendingServer.close).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalled();
    });
  });
});
