import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { closeRedis } from '../../src/redis/client';
import {
  createTestPool,
  createTestRedis,
  resetSale,
  clearRedisKeysForSale,
  readStock,
  deleteSale,
} from '../helpers/testDb';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

const SALE_ID = 'it-queue-active';

describe('POST /api/purchase (queue mode — 202 + worker)', () => {
  let pool: Pool;
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
    const built = buildApp({ saleId: SALE_ID, pool, redis, purchaseMode: 'queue' });
    app = built.app;
  });

  beforeEach(async () => {
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: 100 });
    await clearRedisKeysForSale(redis, SALE_ID);
  });

  afterAll(async () => {
    await app.close();
    await deleteSale(pool, SALE_ID);
    await pool.end();
    await closeRedis(redis);
  });

  function buy(userId: string) {
    return app.inject({ method: 'POST', url: '/api/purchase', payload: { userId } });
  }

  it('answers 202 immediately and the worker commits the purchase', async () => {
    const res = await buy('queued-user');
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.result).toBe('accepted');
    expect(body.attemptId).toBeTypeOf('string');

    await waitFor(async () => {
      const stock = await readStock(pool, SALE_ID);
      return stock.distinctPurchases === 1;
    });

    const check = await app.inject({ method: 'GET', url: '/api/purchases/queued-user' });
    expect(check.json().purchased).toBe(true);
  });

  it('race: 20 users vs stock 5 => exactly 5 wins through the queue', async () => {
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: 5 });
    await clearRedisKeysForSale(redis, SALE_ID);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => buy(`queued-${i}`)),
    );
    expect(responses.every((r) => r.statusCode === 202)).toBe(true);

    await waitFor(async () => (await readStock(pool, SALE_ID)).distinctPurchases === 5);

    const stock = await readStock(pool, SALE_ID);
    expect(stock.soldCount).toBe(5);
    expect(stock.distinctPurchases).toBe(5);

    const winners = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.inject({ method: 'GET', url: `/api/purchases/queued-${i}` }),
      ),
    );
    expect(winners.filter((r) => r.json().purchased)).toHaveLength(5);
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for worker to commit purchase');
}