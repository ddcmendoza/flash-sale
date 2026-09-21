import { useEffect, useState } from 'react';
import type { SaleSnapshot } from '@flash-sale/shared';
import { fetchSales } from '../services/salesApi';

/** Catalog of every sale; `setSales` lets the demo page mirror live frames in. */
export function useSalesCatalog() {
  const [sales, setSales] = useState<SaleSnapshot[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    void fetchSales()
      .then(({ sales: list }) => {
        setSales(list);
        setApiError(null);
      })
      .catch((err) => {
        setApiError(err instanceof Error ? err.message : 'unable to reach API');
      });
  }, []);

  return { sales, setSales, apiError };
}