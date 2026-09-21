import { useEffect, useState } from 'react';
import type { SaleStatusResponse } from '@flash-sale/shared';
import { subscribeToSale } from '../services/sse';

export type LiveState = 'connecting' | 'live' | 'down';

/**
 * Live snapshot for one sale over SSE. The stream is per-sale: when `saleId`
 * changes the previous subscription is torn down and the state resets so a
 * stale countdown/sold count never lingers across sales.
 */
export function useLiveSale(saleId: string | null) {
  const [sale, setSale] = useState<SaleStatusResponse | null>(null);
  const [live, setLive] = useState<LiveState>('connecting');

  useEffect(() => {
    if (!saleId) return;
    setSale(null);
    setLive('connecting');
    return subscribeToSale(saleId, {
      onStatus: (frame) => {
        setSale(frame);
        setLive('live');
      },
      onError: () => setLive('down'),
    });
  }, [saleId]);

  return { sale, live };
}