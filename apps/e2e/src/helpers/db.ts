import { Pool } from 'pg';
import { env } from './env';

export interface GroundTruth {
  soldCount: number;
  totalQuantity: number;
  purchaseRows: number;
}

let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= new Pool({ connectionString: env().dbUrl, max: 5 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Independent ground truth straight from Postgres (no app code involved). */
export async function groundTruth(saleId: string): Promise<GroundTruth> {
  const { rows } = await getPool().query(
    `SELECT
       (SELECT sold_count FROM sales WHERE id = $1)        AS sold_count,
       (SELECT total_quantity FROM sales WHERE id = $1)    AS total_quantity,
       (SELECT count(*) FROM purchases WHERE sale_id = $1) AS purchase_rows`,
    [saleId],
  );
  const row = rows[0] as {
    sold_count: number;
    total_quantity: number;
    purchase_rows: string;
  };
  return {
    soldCount: row.sold_count,
    totalQuantity: row.total_quantity,
    purchaseRows: Number(row.purchase_rows),
  };
}

export async function clearSale(saleId: string): Promise<void> {
  await getPool().query('DELETE FROM purchases WHERE sale_id = $1', [saleId]);
  await getPool().query('DELETE FROM sales WHERE id = $1', [saleId]);
}