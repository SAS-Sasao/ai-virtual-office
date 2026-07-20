#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createServer } from "./server.js";
import { createForwarder } from "./forward.js";
import { createPersistentSeqCounter, resolveSeqPath } from "./seq.js";
import { createRetryBuffer } from "./buffer.js";

const DEFAULT_PORT = 4100;
const DEFAULT_FORWARD_URL = "http://localhost:3001/api/ingest";

interface CliArgs {
  port?: number;
  forward?: string;
}

/**
 * `ai-office-relay [--port N] [--forward URL]` の最小パーサ。
 * 未知の引数は無視する（hooks 経路と無関係な将来のフラグ追加に備え、厳密な
 * バリデーションで CLI 自体が落ちることを避ける）。
 */
function parseArgs(argv: string[]): CliArgs {
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
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

const envPort = process.env.AI_OFFICE_RELAY_PORT
  ? Number(process.env.AI_OFFICE_RELAY_PORT)
  : undefined;
const desiredPort = args.port ?? envPort ?? DEFAULT_PORT;
const forwardUrl = args.forward ?? process.env.AI_OFFICE_FORWARD_URL ?? DEFAULT_FORWARD_URL;
const testMode = process.env.AI_OFFICE_TEST_MODE === "1";

// --port 0（ephemeral）指定時は実際にバインドされたポートが serve() のコールバックで
// しか分からない。/health が正しい port を返せるよう getPort 経由で遅延参照する。
let actualPort = desiredPort;

// forward（成否を boolean で返す）を直接 server に渡さず、RetryBuffer#send を挟む。
// 失敗時はバッファに保持して指数バックオフで再送し、新規イベントは常に直送を試みる
// （head-of-line ブロッキングを避け NFR-1 を守る。M1-2a 設計メモ N-2 参照）。
const buffer = createRetryBuffer({
  forward: createForwarder({ url: forwardUrl }),
});

// seq は Relay 再起動をまたいで単調増加させる（ブロック予約方式の永続採番）。
// 読み書きに失敗した場合は seq を採番しない（undefined。消費側は ts 昇順にフォールバック）。
const nextSeq = createPersistentSeqCounter({ path: resolveSeqPath() });

const app = createServer({
  forward: buffer.send,
  nextSeq,
  testMode,
  getPort: () => actualPort,
});

const server = serve(
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

function shutdown(): void {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
