import type { Pool, PoolClient, QueryResult } from 'pg';
import type {
  AdminPurchaseRecord,
  AdminSaleRecord,
  SaleSnapshot,
} from '@flash-sale/shared';
import { remaining, resolveSaleStatus } from '@flash-sale/shared';

export interface SaleRow {
  id: string;
  name: string;
  price_cents: number;
  total_quantity: number;
  sold_count: number;
  start_at: Date;
  end_at: Date;
}

interface AdminSaleRow extends SaleRow {
  purchase_count: string;
  created_at: Date;
  updated_at: Date;
}

/** Repo-facing partial update; times parsed to `Date` by the service. */
export interface AdminSalePatch {
  name?: string;
  priceCents?: number;
  totalQuantity?: number;
  startAt?: Date;
  endAt?: Date;
}

/** What a purchase pre-check concludes. `open` means "proceed and let the
 * authoritative transaction decide". */
export type SaleGateState = 'open' | 'upcoming' | 'ended' | 'sold_out' | 'not_found';

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

export function toAdminSaleRecord(
  row: AdminSaleRow,
  now: Date = new Date(),
): AdminSaleRecord {
  const snapshot = toSnapshot(row);
  return {
    id: row.id,
    name: row.name,
    priceCents: row.price_cents,
    totalQuantity: row.total_quantity,
    soldCount: row.sold_count,
    remaining: remaining(row.sold_count, row.total_quantity),
    status: resolveSaleStatus(snapshot, now),
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    purchaseCount: Number(row.purchase_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
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

  /** All sales, for the catalog/list endpoint. */
  async findAll(): Promise<SaleSnapshot[]> {
    const { rows } = await this.db.query<SaleRow>(
      'SELECT * FROM sales ORDER BY start_at, id',
    );
    return rows.map(toSnapshot);
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

  /**
   * Authoritative, lock-free pre-check for the purchase path: can this sale be
   * purchased right now, and if not, why?
   *
   * Why not the 1 s status cache: a cached `upcoming` / `ended` / `sold_out`
   * refuses purchases Postgres considers legal for up to a second after a
   * window opens or stock lands. That is a real bug, not a trade-off — it
   * rejects legitimate buyers at the worst possible moment, the start of a sale.
   *
   * So the window is evaluated by the database against its own `now()` (never
   * the client clock, never a cached timestamp), and the precedence matches
   * `resolveSaleStatus` exactly: upcoming, then ended, then sold out.
   *
   * It is a plain MVCC SELECT: it takes no row lock, so it never blocks or
   * serializes with concurrent sellers, and it is only a *pre-filter* — the
   * conditional `UPDATE` inside `PurchaseService.attempt` still decides. A
   * window that opens a millisecond after this read simply loses the race and is
   * admitted by the transaction, which is the safe direction to be wrong in.
   */
  async findGateState(id: string): Promise<SaleGateState> {
    const { rows } = await this.db.query<{
      upcoming: boolean;
      ended: boolean;
      sold_out: boolean;
    }>(
      `SELECT
         (now() < start_at)             AS upcoming,
         (now() > end_at)               AS ended,
         (sold_count >= total_quantity) AS sold_out
       FROM sales
       WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return 'not_found';
    if (row.upcoming) return 'upcoming';
    if (row.ended) return 'ended';
    if (row.sold_out) return 'sold_out';
    return 'open';
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

  // ---- Admin CRUD (demo management surface) ----

  private static readonly ADMIN_COLUMNS = `
    s.id, s.name, s.price_cents, s.total_quantity, s.sold_count,
    s.start_at, s.end_at, s.created_at, s.updated_at,
    (SELECT count(*) FROM purchases p WHERE p.sale_id = s.id) AS purchase_count`;

  async findAllAdmin(): Promise<AdminSaleRecord[]> {
    const { rows } = await this.db.query<AdminSaleRow>(
      `SELECT ${SalesRepo.ADMIN_COLUMNS}
         FROM sales s
        ORDER BY s.start_at, s.id`,
    );
    return rows.map((row) => toAdminSaleRecord(row));
  }

  async findAdminById(id: string): Promise<AdminSaleRecord | null> {
    const { rows } = await this.db.query<AdminSaleRow>(
      `SELECT ${SalesRepo.ADMIN_COLUMNS}
         FROM sales s
        WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toAdminSaleRecord(row) : null;
  }

  /** Insert a new sale. Returns null when the id already exists. */
  async insertSale(input: {
    id: string;
    name: string;
    priceCents: number;
    totalQuantity: number;
    startAt: Date;
    endAt: Date;
  }): Promise<AdminSaleRecord | null> {
    const inserted = await this.db.query(
      `INSERT INTO sales (id, name, price_cents, total_quantity, sold_count, start_at, end_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.name,
        input.priceCents,
        input.totalQuantity,
        input.startAt,
        input.endAt,
      ],
    );
    if ((inserted.rowCount ?? 0) === 0) return null;
    return this.findAdminById(input.id);
  }

  /** Apply a partial update; returns null when the sale does not exist. */
  async updateSale(
    id: string,
    patch: AdminSalePatch,
  ): Promise<AdminSaleRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let param = 1;
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = $${param++}`);
      values.push(value);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.priceCents !== undefined) push('price_cents', patch.priceCents);
    if (patch.totalQuantity !== undefined) push('total_quantity', patch.totalQuantity);
    if (patch.startAt !== undefined) push('start_at', patch.startAt);
    if (patch.endAt !== undefined) push('end_at', patch.endAt);
    if (sets.length === 0) return this.findAdminById(id);

    sets.push(`updated_at = now()`);
    const updated = await this.db.query(
      `UPDATE sales SET ${sets.join(', ')} WHERE id = $${param} RETURNING id`,
      [...values, id],
    );
    if ((updated.rowCount ?? 0) === 0) return null;
    return this.findAdminById(id);
  }

  /** Wipe purchases and zero the counter (demo re-run); false if unknown. */
  async resetSale(id: string, startAt: Date, endAt: Date): Promise<AdminSaleRecord | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM purchases WHERE sale_id = $1', [id]);
      const updated = await client.query(
        `UPDATE sales
            SET sold_count = 0, start_at = $2, end_at = $3, updated_at = now()
          WHERE id = $1
          RETURNING id`,
        [id, startAt, endAt],
      );
      await client.query('COMMIT');
      if ((updated.rowCount ?? 0) === 0) return null;
      return this.findAdminById(id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Delete a sale (purchases cascade) and return whether it existed. */
  async deleteSale(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM sales WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async findPurchases(saleId: string): Promise<AdminPurchaseRecord[]> {
    const { rows } = await this.db.query<{
      id: number;
      created_at: Date;
      user_id: string;
    }>(
      'SELECT id, user_id, created_at FROM purchases WHERE sale_id = $1 ORDER BY created_at, id',
      [saleId],
    );
    return rows.map((row) => ({
      id: row.id,
      saleId,
      userId: row.user_id,
      createdAt: row.created_at.toISOString(),
    }));
  }
}