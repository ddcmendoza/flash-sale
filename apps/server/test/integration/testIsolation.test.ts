import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { closeRedis } from '../../src/redis/client';
import {
  createTestPool,
  createTestRedis,
  resetSale,
  deleteSale,
  readStock,
} from '../helpers/testDb';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

/**
 * The suite runs against the shared dev Postgres/Redis, so anything it creates
 * has to be removable. Postgres rows were cleaned up; the advisory Redis keys
 * were not, and a purchase writes a `purchased` marker on every win. After a
 * `npm test` run, `sale:it-*:purchased:*` keys were still there — 853 of them
 * on this machine — invisible until something reused a sale id and got a 409 for
 * a purchase row that no longer existed.
 *
 * These two tests pin both halves: the marker really is written by a purchase
 * (so the leak is real and not hypothetical), and deleting a sale really does
 * take the keys with it.
 */
describe('test isolation: a deleted sale leaves nothing behind', () => {
  const SALE_ID = 'it-isolation-leak';
  let pool: Pool;
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
    app = buildApp({ saleId: SALE_ID, pool, redis, purchaseMode: 'sync' }).app;
  });

  afterAll(async () => {
    await app.close();
    await deleteSale(pool, redis, SALE_ID);
    await pool.end();
    await closeRedis(redis);
  });

  it('writes a purchased marker on a win and removes it with the sale', async () => {
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: 10 });
    await deleteSale(pool, redis, SALE_ID);
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: 10 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'leaky-buyer' },
    });
    expect(res.statusCode).toBe(201);

    // The marker exists while the purchase does — that is the state the old
    // teardown left behind.
    expect(await redis.exists(`sale:${SALE_ID}:purchased:leaky-buyer`)).toBe(1);
    expect((await readStock(pool, SALE_ID)).soldCount).toBe(1);

    await deleteSale(pool, redis, SALE_ID);

    // Rows gone, and every advisory key for the sale gone with them.
    const rows = await pool.query('SELECT count(*)::int AS n FROM sales WHERE id = $1', [
      SALE_ID,
    ]);
    expect(rows.rows[0]?.n).toBe(0);
    expect(await redis.keys(`sale:${SALE_ID}:*`)).toEqual([]);
  });

  it('bounds the marker lifetime so a flood of unique winners cannot grow Redis without limit', async () => {
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: 10 });
    await deleteSale(pool, redis, SALE_ID);
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: 10 });

    await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'ttl-buyer' },
    });

    // -1 is "no expiry": a permanent key per unique winner, in a system whose
    // subject is a flood of unique users.
    const ttl = await redis.ttl(`sale:${SALE_ID}:purchased:ttl-buyer`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);

    await deleteSale(pool, redis, SALE_ID);
  });
});
