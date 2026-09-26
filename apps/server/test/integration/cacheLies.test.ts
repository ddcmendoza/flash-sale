import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { closeRedis } from '../../src/redis/client';
import {
  ACTIVE_WINDOW_END,
  clearRedisKeysForSale,
  createTestPool,
  createTestRedis,
  deleteSale,
  readStock,
  resetSale,
} from '../helpers/testDb';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

/**
 * The 1 s status cache used to gate *rejections*, not just reads. A cached
 * `upcoming` / `ended` / `sold_out` therefore refused purchases Postgres
 * considered legal, and the refusals were real: report finding #2 measured
 * `committedRows: 0` on a live sale with 50 units in stock.
 *
 * Each test below poisons the cache with a status that is definitively false
 * for the current database state, then buys. The purchase must succeed. These
 * are the report's reproductions, kept as regressions: with the old
 * `peekSaleStatus` fast path each one returned 425/410 and committed nothing.
 */
describe('purchase decisions ignore the cached status snapshot', () => {
  let pool: Pool;
  let redis: Redis;
  let app: FastifyInstance;
  const saleIds: string[] = [];

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
    const built = buildApp({ saleId: 'it-cache-lie', pool, redis, purchaseMode: 'sync' });
    app = built.app;
  });

  afterAll(async () => {
    await app.close();
    for (const saleId of saleIds) await deleteSale(pool, saleId);
    await pool.end();
    await closeRedis(redis);
  });

  async function seed(seed: Parameters<typeof resetSale>[1]): Promise<string> {
    const saleId = await resetSale(pool, seed);
    saleIds.push(saleId);
    await clearRedisKeysForSale(redis, saleId);
    return saleId;
  }

  /** Force a specific status snapshot into the cache the status endpoint reads. */
  async function poisonStatusCache(saleId: string, status: string): Promise<void> {
    await redis.set(
      `sale:${saleId}:status`,
      JSON.stringify({ status, saleId, remaining: 999, totalQuantity: 999, soldCount: 0 }),
      'EX',
      30,
    );
  }

  it('buys through a cached `upcoming` on a sale Postgres says is live', async () => {
    const saleId = await seed({ totalQuantity: 50 });
    await poisonStatusCache(saleId, 'upcoming');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sales/${saleId}/purchase`,
      payload: { userId: 'cache-lies-upcoming' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().result).toBe('purchased');
    expect(await readStock(pool, saleId)).toMatchObject({ soldCount: 1, distinctPurchases: 1 });
  });

  it('buys through a cached `sold_out` on a sale with stock remaining', async () => {
    const saleId = await seed({ totalQuantity: 50 });
    await poisonStatusCache(saleId, 'sold_out');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sales/${saleId}/purchase`,
      payload: { userId: 'cache-lies-sold-out' },
    });

    expect(res.statusCode).toBe(201);
    expect(await readStock(pool, saleId)).toMatchObject({ soldCount: 1, distinctPurchases: 1 });
  });

  it('buys through a cached `ended` inside the real window', async () => {
    const saleId = await seed({ totalQuantity: 10 });
    await poisonStatusCache(saleId, 'ended');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sales/${saleId}/purchase`,
      payload: { userId: 'cache-lies-ended' },
    });

    expect(res.statusCode).toBe(201);
    expect(await readStock(pool, saleId)).toMatchObject({ soldCount: 1, distinctPurchases: 1 });
  });

  it('still refuses a genuinely upcoming sale with 425', async () => {
    const saleId = await seed({
      totalQuantity: 10,
      startAt: new Date(Date.now() + 60_000),
      endAt: ACTIVE_WINDOW_END(),
    });
    await poisonStatusCache(saleId, 'active');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sales/${saleId}/purchase`,
      payload: { userId: 'genuinely-upcoming' },
    });

    expect(res.statusCode).toBe(425);
    expect(await readStock(pool, saleId)).toMatchObject({ soldCount: 0, distinctPurchases: 0 });
  });

  it('still refuses a genuinely ended sale with 410 ended', async () => {
    const saleId = await seed({
      totalQuantity: 10,
      startAt: new Date(Date.now() - 120_000),
      endAt: new Date(Date.now() - 60_000),
    });
    await poisonStatusCache(saleId, 'active');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sales/${saleId}/purchase`,
      payload: { userId: 'genuinely-ended' },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().result).toBe('ended');
  });

  it('still refuses a genuinely sold-out sale with 410 sold_out', async () => {
    const saleId = await seed({ totalQuantity: 1 });
    await app.inject({
      method: 'POST',
      url: `/api/sales/${saleId}/purchase`,
      payload: { userId: 'first-and-only' },
    });
    await clearRedisKeysForSale(redis, saleId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/sales/${saleId}/purchase`,
      payload: { userId: 'second-buyer' },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().result).toBe('sold_out');
  });

  it('returns 404 for a sale that does not exist, without a transaction', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/no-such-sale-at-all/purchase',
      payload: { userId: 'ghost' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().result).toBe('not_found');
  });

  it('keeps the Redis 409 dedupe ahead of the pre-check', async () => {
    const saleId = await seed({ totalQuantity: 1 });
    const url = `/api/sales/${saleId}/purchase`;

    const first = await app.inject({ method: 'POST', url, payload: { userId: 'repeat' } });
    expect(first.statusCode).toBe(201);

    // Now sold out, so the pre-check would answer 410. The committed Redis flag
    // must still win, or a buyer who already has an item gets told to retry.
    const second = await app.inject({ method: 'POST', url, payload: { userId: 'repeat' } });
    expect(second.statusCode).toBe(409);
    expect(second.json().result).toBe('already_purchased');
  });

  it('sees a window that just opened even while the cache says upcoming', async () => {
    // The exact shape of the worst-case in the report: the sale opens now, the
    // cache still says `upcoming`, and the buyer is hammering. Precedence comes
    // from PG `now()`, so the boundary is inclusive.
    const saleId = await seed({
      totalQuantity: 5,
      startAt: new Date(Date.now() - 1_000),
      endAt: ACTIVE_WINDOW_END(),
    });
    await poisonStatusCache(saleId, 'upcoming');

    const res = await app.inject({
      method: 'POST',
      url: `/api/sales/${saleId}/purchase`,
      payload: { userId: 'boundary-buyer' },
    });

    expect(res.statusCode).toBe(201);
  });
});
