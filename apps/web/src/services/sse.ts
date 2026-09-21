import type { SaleStatusResponse } from '@flash-sale/shared';
import { saleEventsUrl } from './salesApi';

export interface SaleStreamHandlers {
  onStatus: (status: SaleStatusResponse) => void;
  onError: () => void;
}

/**
 * Subscribe to the live SSE stream for one sale. The server sends an initial
 * snapshot on connect, a frame after every purchase, and reconciles with
 * Postgres on a ticker, so the stream stays fresh without client polling.
 * Returns an unsubscribe function; the connection never parses twice.
 */
export function subscribeToSale(
  saleId: string,
  { onStatus, onError }: SaleStreamHandlers,
): () => void {
  const source = new EventSource(saleEventsUrl(saleId));
  source.addEventListener('status', (event) => {
    try {
      const frame = JSON.parse((event as MessageEvent).data) as SaleStatusResponse;
      onStatus(frame);
    } catch {
      // malformed frame from a rogue publisher — ignore, wait for the next
    }
  });
  source.onerror = () => onError();
  return () => source.close();
}