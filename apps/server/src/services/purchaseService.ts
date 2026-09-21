import type { Pool, PoolClient } from 'pg';
import type { SaleSnapshot } from '@flash-sale/shared';
import { remaining } from '@flash-sale/shared';

export type PurchaseOutcome =
  | { result: 'purchased'; purchaseId: string }
  | { result: 'invalid_user' }
  | { result: 'already_purchased' }
  | { result: 'sold_out' }
  | { result: 'ended' }
  | { result: 'upcoming' }
  | { result: 'not_found' };

const MAX_USER_ID_LENGTH = 255;

/**
 * The authoritative purchase path. Postgres is the sole source of truth:
 *
 *   1. INSERT the purchase guarded by `NOT EXISTS` on the same (sale, user).
 *      The `UNIQUE(sale_id, user_id)` constraint is the hard stop for a
 *      duplicate — a second concurrent INSERT blocks on the index, then sees
 *      the committed row and inserts nothing.
 *   2. Atomic conditional UPDATE: only bumps sold_count while
 *      `sold_count < total_quantity` AND the window (checked against PG
 *      `now()`) is active. Concurrent sellers serialize on the row lock; each
 *      re-evaluates the predicate against the latest committed row, so at most
 *      `total_quantity` UPDATEs ever match.
 *
 * Redis is never consulted here. Callers may add a Redis fast-path in front,
 * but this service always decides.
 */
export class PurchaseService {
  constructor(
    private readonly pool: Pool,
    private readonly saleId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async attempt(userId: string): Promise<PurchaseOutcome> {
    const user = normalizeUserId(userId);
    if (user === null) return { result: 'invalid_user' };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO purchases (sale_id, user_id)
         SELECT $1::text, $2::text
         WHERE NOT EXISTS (
           SELECT 1 FROM purchases WHERE sale_id = $1 AND user_id = $2
         )
         RETURNING id`,
        [this.saleId, user],
      );

      if ((inserted.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return { result: 'already_purchased' };
      }

      const sold = await client.query<{ sold_count: number }>(
        `UPDATE sales
            SET sold_count = sold_count + 1,
                updated_at = now()
          WHERE id = $1
            AND sold_count < total_quantity
            AND start_at <= now()
            AND end_at >= now()
          RETURNING sold_count`,
        [this.saleId],
      );

      if ((sold.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        const sale = await this.findByIdTx(client);
        return this.classifyWindowFailure(sale);
      }

      await client.query('COMMIT');
      // rowCount is guaranteed > 0 here (checked above); type is non-nullable.
      return { result: 'purchased', purchaseId: inserted.rows[0]!.id };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Two transactions for the same user can overlap: T2's
      // `INSERT ... WHERE NOT EXISTS` sees T1's insert as not-yet-committed,
      // blocks on the unique index, then raises 23505 (unique_violation) once
      // T1 commits. That is not a duplicate INSERT — it is the hard stop
      // working as designed, so map it back to already_purchased rather than
      // letting it surface as a 500.
      if (isUniqueViolation(err)) return { result: 'already_purchased' };
      if (isFkViolation(err)) return { result: 'not_found' };
      throw err;
    } finally {
      client.release();
    }
  }

  private async findByIdTx(client: PoolClient): Promise<SaleSnapshot | null> {
    const { rows } = await client.query<{
      id: string;
      name: string;
      price_cents: number;
      total_quantity: number;
      sold_count: number;
      start_at: Date;
      end_at: Date;
    }>('SELECT * FROM sales WHERE id = $1', [this.saleId]);
    const row = rows[0];
    if (!row) return null;
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

  /** Pick the most accurate reason the guarded UPDATE matched nothing. */
  private classifyWindowFailure(sale: SaleSnapshot | null): PurchaseOutcome {
    if (!sale) return { result: 'not_found' };
    const now = this.now();
    if (now < sale.startAt) return { result: 'upcoming' };
    if (now > sale.endAt) return { result: 'ended' };
    if (remaining(sale.soldCount, sale.totalQuantity) === 0) {
      return { result: 'sold_out' };
    }
    // Fallback: window is active and stock remains, but the UPDATE missed —
    // only possible under a boundary race. Report sold_out to be safe; the
    // client is encouraged to retry, and the DB never double-sold.
    return { result: 'sold_out' };
  }
}

function normalizeUserId(userId: string): string | null {
  const trimmed = userId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_USER_ID_LENGTH) return null;
  return trimmed;
}

function isFkViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23503'
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}