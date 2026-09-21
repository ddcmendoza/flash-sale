import type { Pool } from 'pg';

export interface StockGroundTruth {
  totalQuantity: number;
  soldCount: number;
  distinctPurchases: number;
}

/**
 * Independent verification straight from Postgres: the harness trusts the
 * HTTP responses only as far as the counters agree with the source of truth.
 */
export async function readGroundTruth(
  pool: Pool,
  saleId: string,
): Promise<StockGroundTruth> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT total_quantity FROM sales WHERE id = $1)       AS total_quantity,
       (SELECT sold_count FROM sales WHERE id = $1)           AS sold_count,
       (SELECT count(*) FROM purchases WHERE sale_id = $1)    AS distinct_purchases
     FROM (VALUES (1)) AS t`,
    [saleId],
  );
  const row = rows[0] as {
    total_quantity: number;
    sold_count: number;
    distinct_purchases: string;
  };
  return {
    totalQuantity: row.total_quantity,
    soldCount: row.sold_count,
    distinctPurchases: Number(row.distinct_purchases),
  };
}

export async function resetSale(pool: Pool, saleId: string): Promise<void> {
  await pool.query('DELETE FROM purchases WHERE sale_id = $1', [saleId]);
  await pool.query('UPDATE sales SET sold_count = 0 WHERE id = $1', [saleId]);
}

export async function listWinners(pool: Pool, saleId: string): Promise<string[]> {
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM purchases WHERE sale_id = $1',
    [saleId],
  );
  return rows.map((r) => r.user_id);
}