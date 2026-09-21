import type { Pool, PoolClient, QueryResult } from 'pg';
import type { SaleSnapshot } from '@flash-sale/shared';

export interface SaleRow {
  id: string;
  name: string;
  price_cents: number;
  total_quantity: number;
  sold_count: number;
  start_at: Date;
  end_at: Date;
}

export function toSnapshot(row: SaleRow): SaleSnapshot {
  return {
    id: row.id,
    name: row.name,
    priceCents: row.price_cents,
    totalQuantity: row.total_quantity,
    soldCount: row.sold_count,
    startAt: row.start_at,
    endAt: row.end_at,
  };
}

export class SalesRepo {
  constructor(private readonly db: Pool) {}

  async findById(id: string): Promise<SaleSnapshot | null> {
    const { rows } = await this.db.query<SaleRow>(
      'SELECT * FROM sales WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? toSnapshot(row) : null;
  }

  /** Read within an open transaction (used for error classification). */
  async findByIdTx(client: PoolClient, id: string): Promise<SaleSnapshot | null> {
    const { rows } = await client.query<SaleRow>(
      'SELECT * FROM sales WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? toSnapshot(row) : null;
  }

  /** Postgres is the source of truth; used by the stress harness + tests. */
  async assertStockIntegrity(id: string): Promise<{
    soldCount: number;
    totalQuantity: number;
    distinctPurchases: number;
  }> {
    const result: QueryResult = await this.db.query(
      `SELECT
         (SELECT sold_count FROM sales WHERE id = $1)            AS sold_count,
         (SELECT total_quantity FROM sales WHERE id = $1)        AS total_quantity,
         (SELECT count(*) FROM purchases WHERE sale_id = $1)     AS distinct_purchases`,
      [id],
    );
    const row = result.rows[0] as {
      sold_count: number;
      total_quantity: number;
      distinct_purchases: string;
    };
    return {
      soldCount: row.sold_count,
      totalQuantity: row.total_quantity,
      distinctPurchases: Number(row.distinct_purchases),
    };
  }
}