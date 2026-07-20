import type { OfficeEvent } from "@ai-office/protocol";

/**
 * 成否を戻り値で返す転送関数。
 *
 * NFR-2: 転送失敗（ネットワークエラー・非 2xx 応答のいずれも含む）でも
 * 絶対に throw しない。成功（2xx）なら true、失敗なら false を返す。
 * 呼び出し側（src/buffer.ts の RetryBuffer）はこの戻り値だけを見て
 * 再送要否を判断できる。
 */
export type Forwarder = (event: OfficeEvent) => Promise<boolean>;

export interface CreateForwarderOptions {
  /** 転送先 URL（例: web の /api/ingest）。 */
  url: string;
  /** fetch 実装。既定は globalThis.fetch（テストから注入可能）。 */
  fetchImpl?: typeof fetch;
}

/**
 * web の /api/ingest へ OfficeEvent を POST 転送する forwarder を生成する。
 *
 * NFR-2: 転送失敗（ネットワークエラー・非 2xx 応答のいずれも含む）は
 * console.warn のみで握り潰し、絶対に throw しない。Relay 自体、および
 * Relay の呼び出し元（hooks コマンド）を絶対にブロックしないための設計。
 */
export function createForwarder(options: CreateForwarderOptions): Forwarder {
  const { url, fetchImpl = globalThis.fetch } = options;

  return async (event: OfficeEvent): Promise<boolean> => {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!res.ok) {
        console.warn(`relay: forward to ${url} responded with status ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`relay: forward to ${url} failed`, err);
      return false;
    }
  };
}
