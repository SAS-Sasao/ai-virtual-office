#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createServer } from "./server.js";
import { createForwarder } from "./forward.js";
import { createPersistentSeqCounter, resolveSeqPath } from "./seq.js";
import { createRetryBuffer, type RetryBuffer } from "./buffer.js";
import { loadAttributor, resolveAttributionPath } from "./attribute.js";

const DEFAULT_PORT = 4100;
const DEFAULT_FORWARD_URL = "http://localhost:3001/api/ingest";

// SIGINT/SIGTERM 受信後、server.close() の完了を待つ猶予（ms）。これを超えても
// close が完了しない場合（例: 再送バッファのドレイン待ち等でハングする）は
// deps.exit(0) で強制終了する。graceful shutdown が Ctrl+C を無効化してしまう
// 事故を防ぐための保険（AC-6）。
const FORCE_SHUTDOWN_MS = 5000;

export interface CliArgs {
  port?: number;
  forward?: string;
  attribution?: string;
}

/**
 * `ai-office-relay [--port N] [--forward URL] [--attribution PATH]` の最小パーサ。
 * 未知の引数は無視する（hooks 経路と無関係な将来のフラグ追加に備え、厳密な
 * バリデーションで CLI 自体が落ちることを避ける）。
 *
 * ポート値の妥当性はここでは検証しない（`--port` は文字列 → 数値変換のみ行い、
 * 検証は `validatePort` の責務に分離する。parseArgs は常に例外を投げない）。
 */
export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value !== undefined) {
        result.port = Number(value);
        i += 1;
      }
    } else if (arg === "--forward") {
      const value = argv[i + 1];
      if (value !== undefined) {
        result.forward = value;
        i += 1;
      }
    } else if (arg === "--attribution") {
      const value = argv[i + 1];
      if (value !== undefined) {
        result.attribution = value;
        i += 1;
      }
    }
  }
  return result;
}

/**
 * 解決済みポート値（--port / env / 既定のいずれか）を検証する純関数（AC-5）。
 * 不正な場合は throw する（呼び出し側が `deps.exit(1)` へつなげる）。
 *
 * `0` は「OS にエフェメラルポートを選ばせる」ための正当な値として許容する
 * （`serve()` のコールバックで実ポートを確定させる既存の起動パターン。
 * `.claude/skills/office-verify/scripts/verify.sh` が `--port 0` に依存しているため、
 * 監査由来の「1-65535」という記述は 0 を含む範囲として解釈する — この実装判断は
 * verify.sh / dogfooding を壊さないことを最優先した結果であり、完了報告に明記する）。
 */
export function validatePort(raw: unknown): number {
  // `Number(null)` === 0 / `Number("")` === 0 のように、Number() の緩い変換規則で
  // null・空文字・真偽値が「有効な 0」として通り抜けてしまわないよう、
  // number か非空文字列のみを変換対象にする（それ以外は NaN 扱いで throw）。
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && raw.trim().length > 0) {
    value = Number(raw);
  } else {
    value = Number.NaN;
  }
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(
      `relay: invalid port ${JSON.stringify(raw)} (must be an integer between 0 and 65535; 0 selects an ephemeral port)`,
    );
  }
  return value;
}

type ServeFn = typeof serve;

/**
 * `deps.setTimeout` の戻り値。本物の Node `Timeout` は `.unref()` を持つ。
 * テストダブルは `unref` を省略してもよい（optional）。
 */
export interface CancellableTimer {
  unref?: () => void;
}

/**
 * cli.ts の副作用（サーバ bind・プロセス終了・タイマー・signal 登録）をすべて
 * 注入可能にする DI 契約。既定値はすべて本物（`@hono/node-server` の `serve` /
 * `process.exit` / `setTimeout` / `process.on`）。
 *
 * テストはこれらをスタブに差し替えることで、実 :4100 バインドや実プロセス終了を
 * 一切発生させずに AC-4/5/6 を決定論的に検証できる（NFR-8）。
 */
export interface RelayRuntimeDeps {
  /** CLI 引数（`--port` 等）。既定は `process.argv.slice(2)`。 */
  argv: string[];
  /** 環境変数（`AI_OFFICE_RELAY_PORT` 等）。既定は `process.env`。 */
  env: NodeJS.ProcessEnv;
  /** サーバ bind（既定 = 実 `@hono/node-server` の `serve`）。 */
  serve: ServeFn;
  /** プロセス終了（既定 = `process.exit`）。 */
  exit: (code: number) => void;
  /** タイマー登録（既定 = 実 `setTimeout`）。graceful shutdown の強制終了ガードに使う。 */
  setTimeout: (fn: () => void, ms: number) => CancellableTimer;
  /** シグナル登録（既定 = `process.on`）。 */
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  /** 現在時刻（既定は `createServer` 自身の既定 = `Date.now`）。テストの決定論性のため注入可能。 */
  now?: () => number;
  /**
   * 再送バッファ（既定 = 未指定。`createRelayRuntime` が `forwardUrl` 解決後に
   * 実 `RetryBuffer`（`createRetryBuffer`）を構築する。本番挙動は不変）。
   *
   * テストは `size()` が任意の値を返す偽 buffer を注入することで、shutdown 開始時の
   * 滞留 warn（AC-6 の正分岐: `buffer.size() > 0` → `console.warn(...)`）を
   * `createRelayRuntime` 内部生成に頼らず決定論的に検証できる。
   */
  buffer?: RetryBuffer;
}

/**
 * Relay の実体を構築し起動する（cli.ts の旧トップレベル副作用スクリプトから
 * 抽出）。この関数自体は import しても実行されない（呼び出し側が明示的に
 * 呼ぶまで一切の副作用を発生させない）。
 *
 * - AC-4: `server.on('error', ...)` でポート bind 失敗（EADDRINUSE 等）を
 *   捕捉し、uncaughtException に昇格させず明示メッセージ + `deps.exit(1)` する。
 * - AC-5: 解決済みポート値を `validatePort` で検証し、不正なら `serve` を
 *   呼ばずに明示メッセージ + `deps.exit(1)` する（`listen(NaN)` の
 *   RangeError を未然に防ぐ）。
 * - AC-6: SIGINT/SIGTERM で graceful shutdown する。①強制終了ガード
 *   （`deps.setTimeout` + `.unref()`）②再送バッファ滞留時の warn
 *   ③2 度目の signal を待たない再入ガード、を備える。
 */
export function createRelayRuntime(deps: RelayRuntimeDeps): void {
  const args = parseArgs(deps.argv);

  const envPortRaw = deps.env.AI_OFFICE_RELAY_PORT;
  const rawPort = args.port ?? (envPortRaw !== undefined ? Number(envPortRaw) : undefined) ?? DEFAULT_PORT;

  let desiredPort: number;
  try {
    desiredPort = validatePort(rawPort);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
    return;
  }

  const forwardUrl = args.forward ?? deps.env.AI_OFFICE_FORWARD_URL ?? DEFAULT_FORWARD_URL;
  const testMode = deps.env.AI_OFFICE_TEST_MODE === "1";

  // --port 0（ephemeral）指定時は実際にバインドされたポートが serve() のコールバックで
  // しか分からない。/health が正しい port を返せるよう getPort 経由で遅延参照する。
  let actualPort = desiredPort;

  // forward（成否を boolean で返す）を直接 server に渡さず、RetryBuffer#send を挟む。
  // 失敗時はバッファに保持して指数バックオフで再送し、新規イベントは常に直送を試みる
  // （head-of-line ブロッキングを避け NFR-1 を守る。M1-2a 設計メモ N-2 参照）。
  // `deps.buffer` が注入されていればそれを使う（テストが shutdown 時の滞留 warn を
  // 検証するための DI ポイント。既定＝未注入時は本物の RetryBuffer を構築する）。
  const buffer =
    deps.buffer ??
    createRetryBuffer({
      forward: createForwarder({ url: forwardUrl }),
    });

  // seq は Relay 再起動をまたいで単調増加させる（ブロック予約方式の永続採番）。
  // 読み書きに失敗した場合は seq を採番しない（undefined。消費側は ts 昇順にフォールバック）。
  const nextSeq = createPersistentSeqCounter({ path: resolveSeqPath(deps.env) });

  // FR-4: attribution.json（cc-sier-adapter が生成）を読み、org/dept/role の帰属推定を
  // 有効化する。ファイルが無い・壊れている場合も loadAttributor が graceful degradation
  // してくれるため、M0 からの利用者（attribution.json 未生成）を壊さずに常に正常起動する。
  const attributionPath = args.attribution ?? resolveAttributionPath(deps.env);
  const attribute = loadAttributor({ path: attributionPath });

  const app = createServer({
    forward: buffer.send,
    nextSeq,
    testMode,
    getPort: () => actualPort,
    attribute,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  const server = deps.serve(
    {
      fetch: app.fetch,
      port: desiredPort,
    },
    (info) => {
      actualPort = info.port;
      // verify.sh はこの 1 行を読んで実際にバインドされたポートを取得する（--port 0 対応）。
      // 形式・文言を変更する場合は verify.sh 側も合わせて更新すること。
      console.log(`relay listening on port ${actualPort}`);
    },
  );

  // AC-4: ポート bind 失敗（EADDRINUSE 等）を uncaughtException に昇格させず、
  // 明示メッセージ + exit(1) で終了する。
  server.on("error", (err: unknown) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE") {
      console.error(
        `relay: port ${desiredPort} is already in use (EADDRINUSE). Is another relay already running?`,
      );
    } else {
      console.error(`relay: server error: ${err instanceof Error ? err.message : String(err)}`);
    }
    deps.exit(1);
  });

  // AC-6: graceful shutdown。SIGINT/SIGTERM の再入ガード + 滞留 warn + 強制終了ガード。
  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) {
      // 2 度目の signal は server.close() の完了を待たず即終了する
      // （利用者が Ctrl+C を連打しても確実に反応する）。
      deps.exit(1);
      return;
    }
    shuttingDown = true;

    if (buffer.size() > 0) {
      console.warn(
        `relay: shutting down with ${buffer.size()} event(s) still pending in the retry buffer`,
      );
    }

    // server.close() が（滞留処理等で）完了せずハングし続けても Ctrl+C が
    // 効かなくなることがないよう、強制終了ガードを仕掛ける。`.unref()` により
    // このタイマー自体がプロセスの生存理由にはならない。
    const forceExitTimer = deps.setTimeout(() => {
      deps.exit(0);
    }, FORCE_SHUTDOWN_MS);
    forceExitTimer.unref?.();

    server.close(() => {
      deps.exit(0);
    });
  }

  deps.onSignal("SIGINT", shutdown);
  deps.onSignal("SIGTERM", shutdown);
}

/**
 * `createRelayRuntime` の既定 deps（本物の `serve`/`process.exit`/`setTimeout`/
 * `process.on`）を組み立てて起動するエントリポイント。`overrides` で一部だけ
 * 差し替えられる（テストは通常こちらではなく `createRelayRuntime` を直接、
 * 完全に指定した deps で呼ぶ）。
 *
 * 既定値の解決は呼び出し時に遅延して行う（モジュールの import 時点では
 * `process.argv`/`process.env` すら参照しない）。これにより import 時の
 * 副作用をゼロに保つ（NFR-8・rev.2 設計メモ F2 対応）。
 */
export function main(overrides: Partial<RelayRuntimeDeps> = {}): void {
  const deps: RelayRuntimeDeps = {
    argv: overrides.argv ?? process.argv.slice(2),
    env: overrides.env ?? process.env,
    serve: overrides.serve ?? serve,
    exit: overrides.exit ?? ((code) => process.exit(code)),
    setTimeout: overrides.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    onSignal:
      overrides.onSignal ??
      ((signal, handler) => {
        process.on(signal, handler);
      }),
    now: overrides.now,
    buffer: overrides.buffer,
  };

  createRelayRuntime(deps);
}

// このモジュールが `node cli.js` として直接実行された場合のみ起動する
// （import 時の副作用ゼロ。先例: packages/cc-sier-adapter/src/cli.ts の
// is-main ガード）。テストからの `import` では一切副作用が起きない。
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
