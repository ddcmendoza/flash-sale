import { useCallback, useEffect, useState } from 'react';
import type { AdminSaleRecord } from '@flash-sale/shared';
import { fetchAdminSales } from '../services/adminApi';

/** Admin catalog plus a `refresh` that re-reads from the admin API. */
export function useAdminSales() {
  const [sales, setSales] = useState<AdminSaleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSales((await fetchAdminSales()).sales);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load sales');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sales, setSales, loading, error, refresh };
}