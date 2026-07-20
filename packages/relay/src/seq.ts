import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Relay プロセス内で単調増加する seq を発行するカウンタを生成する（プロセス内限定・
 * 非永続）。テストの既定 nextSeq、および永続化が不要な用途向けに引き続き提供する。
 *
 * グローバル変数を使わず、生成関数のクロージャに state を閉じ込めることで、
 * テストごとに独立したカウンタを作れるようにしている（テスト間の状態漏れ防止）。
 *
 * 順序規約（packages/protocol の OfficeEventSchema doc comment 参照）: この seq は
 * Relay プロセス内でのみ単調増加を保証する。
 */
export function createSeqCounter(start = 0): () => number {
  let next = start;
  return (): number => {
    const current = next;
    next += 1;
    return current;
  };
}

const DEFAULT_SEQ_RELATIVE_PATH = join(".ai-office", "relay-seq.json");

/**
 * seq 永続化状態ファイルのパスを解決する。
 * `AI_OFFICE_SEQ_PATH` > 既定 `~/.ai-office/relay-seq.json`。
 *
 * `env` は DI 可能（既定 `process.env`）。テストは `process.env` を汚さずに
 * 任意の env オブジェクトを渡せる。
 */
export function resolveSeqPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_OFFICE_SEQ_PATH ?? join(homedir(), DEFAULT_SEQ_RELATIVE_PATH);
}

/** seq 永続化状態ファイルの内容。 */
export interface SeqState {
  lastSeq: number;
}

/**
 * seq 状態ファイルの読み書きを抽象化する DI ポイント。
 *
 * - `readState()`: ファイルが存在しない場合は `undefined` を返す（失敗ではない、
 *   0 起点として扱う）。読み取れるが壊れている・権限が無い等の**失敗時は throw する**。
 * - `writeState()`: 書き込みに**失敗した場合は throw する**。
 *
 * 既定実装（`createFsSeqStateIO`）は `path` に対して Node の `fs` 同期 API を使う。
 * テストは一時ディレクトリを使う（本番実装のまま）か、この interface を満たす
 * モックを注入して読み書き失敗を決定論的に再現できる。
 */
export interface SeqStateIO {
  readState: () => SeqState | undefined;
  writeState: (state: SeqState) => void;
}

function createFsSeqStateIO(path: string): SeqStateIO {
  return {
    readState: (): SeqState | undefined => {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw err;
      }
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { lastSeq?: unknown }).lastSeq !== "number" ||
        !Number.isInteger((parsed as { lastSeq: number }).lastSeq) ||
        (parsed as { lastSeq: number }).lastSeq < 0
      ) {
        throw new Error(`relay: invalid seq state in ${path}`);
      }
      return { lastSeq: (parsed as { lastSeq: number }).lastSeq };
    },
    writeState: (state: SeqState): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state), "utf8");
    },
  };
}

export interface CreatePersistentSeqCounterOptions {
  /** 状態ファイルのパス（`resolveSeqPath()` の戻り値を渡すのが通常）。 */
  path: string;
  /** 1 回の予約で消費するブロックサイズ（既定 1000）。 */
  blockSize?: number;
  /** ファイル I/O の DI（既定は `path` に対する実 fs I/O）。 */
  io?: SeqStateIO;
}

/**
 * Relay 再起動をまたいで単調増加する seq を発行するカウンタを生成する
 * （ブロック予約方式）。
 *
 * - 初回呼び出し時、状態ファイルの `lastSeq`（無ければ 0）から
 *   `blockSize` 件分のブロックを予約し、**即座にファイルへ保存**してから
 *   その先頭値を返す。以降 `blockSize` 件は I/O 無しでメモリ上のカウンタを
 *   進めるだけで発行できる。ブロックを使い切ったら次のブロックを同様に予約する。
 * - クラッシュ時は予約済みブロックの未使用分だけ gap が生じ得るが、
 *   protocol の順序規約は「昇順」であって連番を要求しないため許容する。
 * - **読み取り or 書き込みに失敗した場合は seq を採番せず `undefined` を返す**。
 *   0 起点に巻き戻して既発行の seq と逆行させることは絶対にしない。失敗は
 *   一時的なものかもしれないため、次回呼び出し時に再度予約を試みる
 *   （状態は「壊れたまま固定」にはしない）。
 */
export function createPersistentSeqCounter(
  options: CreatePersistentSeqCounterOptions,
): () => number | undefined {
  const { path, blockSize = 1000, io = createFsSeqStateIO(path) } = options;

  // current: 次に発行する値。undefined はまだ/現在ブロック未予約であることを示す。
  // blockEnd: 予約済みブロックの排他的上限（current がこれ以上ならブロック使い切り）。
  let current: number | undefined;
  let blockEnd = 0;

  function reserveNextBlock(): boolean {
    let lastSeq: number;
    try {
      const state = io.readState();
      lastSeq = state?.lastSeq ?? 0;
    } catch (err) {
      console.warn(`relay: failed to read seq state from ${path} (seq will not be issued)`, err);
      return false;
    }

    const newLastSeq = lastSeq + blockSize;
    try {
      io.writeState({ lastSeq: newLastSeq });
    } catch (err) {
      console.warn(`relay: failed to write seq state to ${path} (seq will not be issued)`, err);
      return false;
    }

    current = lastSeq;
    blockEnd = newLastSeq;
    return true;
  }

  return (): number | undefined => {
    if (current === undefined || current >= blockEnd) {
      const reserved = reserveNextBlock();
      if (!reserved) {
        return undefined;
      }
    }
    const value = current as number;
    current = value + 1;
    return value;
  };
}
