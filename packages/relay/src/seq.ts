import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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

/**
 * seq 状態ファイルへの**書き込み経路のみ**を対象にした fs DI ファサード
 * （読み取りは対象外。write の durability と read の関心を分離する。
 * rev.2 設計メモ低 finding #2）。既定 = 実 `node:fs`。
 *
 * `writeFileSync` は現在の `writeState` 実装（`openSync`/`writeSync`/
 * `fsyncSync`/`closeSync` で 1 つの fd を書き込みから fsync まで使い回す方式）
 * では呼び出さない。DI 契約の完全性のためファサード型には残すが、テストの
 * スタブがこれを省略しても（`?`）動作に影響しない。
 */
export interface SeqWriteFsFacade {
  writeFileSync?: typeof writeFileSync;
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  mkdirSync: typeof mkdirSync;
}

const defaultFsFacade: SeqWriteFsFacade = {
  writeFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  mkdirSync,
};

/**
 * `path` に対する既定の `SeqStateIO` を構築する。
 *
 * - `readState`: 従来どおり実 `node:fs`（`readFileSync`）を直接使う（`fsFacade` の
 *   対象外。読み取り経路は変更しない）。
 * - `writeState`（AC-1/AC-2）: `${path}.tmp` に書き込み、`fsyncSync` で
 *   ディスクへの反映を試みてから `renameSync(tmp, path)` でアトミックに
 *   置き換える。rename が失敗した場合は `unlinkSync(tmp)` で後始末し、
 *   `path` 自体には一切書き込んでいないため常に不変のまま残る。
 *   durability は **best-effort**（このファイルの fsync のみ。親ディレクトリの
 *   fsync は行わない＝完全な電源断耐性は主張しない。rev.2 設計メモ低 finding #5）。
 *
 * `fsFacade` は write 経路のみの DI ポイント（既定 = `node:fs`）。テストは
 * これをスタブして呼び出し順序・失敗系を決定論的に検証できる。
 */
export function createFsSeqStateIO(
  path: string,
  fsFacade: SeqWriteFsFacade = defaultFsFacade,
): SeqStateIO {
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
      fsFacade.mkdirSync(dirname(path), { recursive: true });
      const tmpPath = `${path}.tmp`;
      const data = JSON.stringify(state);

      const fd = fsFacade.openSync(tmpPath, "w");
      try {
        fsFacade.writeSync(fd, data, null, "utf8");
        fsFacade.fsyncSync(fd);
      } finally {
        fsFacade.closeSync(fd);
      }

      try {
        fsFacade.renameSync(tmpPath, path);
      } catch (err) {
        try {
          fsFacade.unlinkSync(tmpPath);
        } catch {
          // best-effort cleanup: unlink 自体の失敗は無視し、元の rename エラーを
          // 優先して伝播する（path は書き換えていないため不変のまま）。
        }
        throw err;
      }
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
 *
 * `blockSize` は正の整数でなければならない（AC-3）。0/負値/非整数を渡すと
 * ブロック予約が単調増加せず重複 seq を生みかねないため、構築時（呼び出し前）に
 * throw して設定ミスを起動時に検出できるようにする。
 */
export function createPersistentSeqCounter(
  options: CreatePersistentSeqCounterOptions,
): () => number | undefined {
  const { path, blockSize = 1000, io = createFsSeqStateIO(path) } = options;

  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new Error(
      `relay: createPersistentSeqCounter requires an integer blockSize >= 1 (got ${blockSize})`,
    );
  }

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
