import { Pool, type PoolConfig } from 'pg';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { config } from '../../src/config';
import { createAdvisoryRedis } from '../../src/redis/client';

export interface TestSaleSeed {
  saleId?: string;
  name?: string;
  priceCents?: number;
  totalQuantity?: number;
  startAt?: Date;
  endAt?: Date;
}

export const ACTIVE_WINDOW_START = () => new Date(Date.now() - 5 * 60_000);
export const ACTIVE_WINDOW_END = () => new Date(Date.now() + 5 * 60_000);

export function createTestPool(poolConfig?: PoolConfig): Pool {
  return new Pool({ connectionString: config.databaseUrl, max: 25, ...poolConfig });
}

/** The same advisory client the server builds, so the tests exercise the real
 * fail-fast options rather than a permissive test-only client. */
export function createTestRedis(): Redis {
  return createAdvisoryRedis(config.redisUrl, 'test');
}

/**
 * Point a sale at a fresh, exactly-known state. Uses a new saleId by default
 * so Redis caches from other tests can't leak in; pass saleId to reseed.
 */
export async function resetSale(
  pool: Pool,
  seed: TestSaleSeed = {},
): Promise<string> {
  const saleId = seed.saleId ?? `test-${randomUUID()}`;
  const startAt = seed.startAt ?? ACTIVE_WINDOW_START();
  const endAt = seed.endAt ?? ACTIVE_WINDOW_END();

  await pool.query('DELETE FROM purchases WHERE sale_id = $1', [saleId]);
  await pool.query(
    `INSERT INTO sales (id, name, price_cents, total_quantity, sold_count, start_at, end_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       name          = EXCLUDED.name,
       price_cents   = EXCLUDED.price_cents,
       total_quantity = EXCLUDED.total_quantity,
       sold_count     = 0,
       start_at       = EXCLUDED.start_at,
       end_at         = EXCLUDED.end_at`,
    [
      saleId,
      seed.name ?? 'Test Sale',
      seed.priceCents ?? 19900,
      seed.totalQuantity ?? 100,
      startAt,
      endAt,
    ],
  );
  return saleId;
}

export async function clearRedisKeysForSale(redis: Redis, saleId: string): Promise<void> {
  const keys = await redis.keys(`sale:${saleId}:*`);
  if (keys.length > 0) await redis.del(keys);
}

/** Remove a sale and every trace of it. Use in test teardowns so random sale
 * ids don't accumulate in the shared dev database (they show up in
 * GET /api/sales) and so the suite doesn't accumulate Redis state either.
 *
 * The Redis half is not optional bookkeeping. A purchase writes a `purchased`
 * dedupe marker, and those markers outlive the rows: a teardown that deleted
 * only the Postgres rows left `sale:<id>:purchased:*` behind forever. They are
 * invisible until a test reuses a sale id and gets a 409 for a purchase row
 * that no longer exists — so this takes the redis client and clears both. */
export async function deleteSale(
  pool: Pool,
  redis: Redis,
  saleId: string,
): Promise<void> {
  await clearRedisKeysForSale(redis, saleId);
  await pool.query('DELETE FROM purchases WHERE sale_id = $1', [saleId]);
  await pool.query('DELETE FROM sales WHERE id = $1', [saleId]);
}

export interface StockSummary {
  soldCount: number;
  totalQuantity: number;
  distinctPurchases: number;
}

/** Independent ground truth straight from Postgres (no app code involved). */
export async function readStock(pool: Pool, saleId: string): Promise<StockSummary> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT sold_count FROM sales WHERE id = $1)          AS sold_count,
       (SELECT total_quantity FROM sales WHERE id = $1)      AS total_quantity,
       (SELECT count(*) FROM purchases WHERE sale_id = $1)   AS distinct_purchases`,
    [saleId],
  );
  const row = rows[0] as {
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