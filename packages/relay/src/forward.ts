import type { OfficeEvent } from "@ai-office/protocol";

/**
 * クラウド転送境界で `requestText`（ローカル限定の依頼文本文、ADR-007）を
 * 取り除いた新しい OfficeEvent を返す純関数。元の event は変更しない。
 *
 * ⚠**将来クラウド向け forwarder を実装する際は、必ずこの関数を通してから
 * 送信すること**（M3 で実装予定。本サイクルではローカル転送のみのため未使用の
 * ready seam）。`createForwarder`（このファイル）はローカル web の
 * `/api/ingest` へ送るものであり、ローカルでは `requestText` を含めて送信する
 * のが正しい（NFR-4 はクラウド境界にのみ適用される。ADR-007 参照）。
 */
export function stripCloudSensitive(event: OfficeEvent): OfficeEvent {
  const { requestText: _requestText, ...rest } = event;
  return rest;
}

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
