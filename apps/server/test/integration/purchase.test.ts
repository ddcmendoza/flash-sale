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

const SALE_ID = 'it-purchase-active';
const STOCK = 100;

describe('POST /api/purchase (sync mode)', () => {
  let pool: Pool;
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
    const built = buildApp({
      saleId: SALE_ID,
      pool,
      redis,
      purchaseMode: 'sync',
    });
    app = built.app;
  });

  beforeEach(async () => {
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: STOCK });
    await clearRedisKeysForSale(redis, SALE_ID);
  });

  afterAll(async () => {
    await app.close();
    await deleteSale(pool, redis, SALE_ID);
    await pool.end();
    await closeRedis(redis);
  });

  function buy(userId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId },
    });
  }

  it('confirms a purchase and records it exactly once', async () => {
    const res = await buy('alice');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.result).toBe('purchased');
    expect(body.purchaseId).toBeTypeOf('string');

    const stock = await readStock(pool, SALE_ID);
    expect(stock.soldCount).toBe(1);
    expect(stock.distinctPurchases).toBe(1);

    const check = await app.inject({ method: 'GET', url: '/api/purchases/alice' });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ userId: 'alice', purchased: true });
  });

  it('rejects a repeat buyer without inflating stock', async () => {
    expect((await buy('bob')).statusCode).toBe(201);
    const second = await buy('bob');
    expect(second.statusCode).toBe(409);
    expect(second.json().result).toBe('already_purchased');

    const stock = await readStock(pool, SALE_ID);
    expect(stock.soldCount).toBe(1);
    expect(stock.distinctPurchases).toBe(1);
  });

  it('accepts a purchase exactly at the start boundary', async () => {
    await resetSale(pool, {
      saleId: SALE_ID,
      startAt: new Date(Date.now() - 100),
      endAt: new Date(Date.now() + 60_000),
    });
    await clearRedisKeysForSale(redis, SALE_ID);
    const res = await buy('boundary-user');
    expect(res.statusCode).toBe(201);
  });

  it('returns 425 for an upcoming sale', async () => {
    await resetSale(pool, {
      saleId: SALE_ID,
      startAt: new Date(Date.now() + 60_000),
      endAt: new Date(Date.now() + 120_000),
    });
    await clearRedisKeysForSale(redis, SALE_ID);
    const res = await buy('early-user');
    expect(res.statusCode).toBe(425);
    expect(res.json().result).toBe('upcoming');
    expect((await readStock(pool, SALE_ID)).soldCount).toBe(0);
  });

  it('returns 410 ended after the window closes', async () => {
    await resetSale(pool, {
      saleId: SALE_ID,
      startAt: new Date(Date.now() - 120_000),
      endAt: new Date(Date.now() - 60_000),
    });
    await clearRedisKeysForSale(redis, SALE_ID);
    const res = await buy('late-user');
    expect(res.statusCode).toBe(410);
    expect(res.json().result).toBe('ended');
    expect((await readStock(pool, SALE_ID)).soldCount).toBe(0);
  });

  it('returns 410 sold_out when stock is exhausted', async () => {
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: 0 });
    await clearRedisKeysForSale(redis, SALE_ID);
    const res = await buy('anyone');
    expect(res.statusCode).toBe(410);
    expect(res.json().result).toBe('sold_out');
  });

  it('returns 400 for invalid user ids', async () => {
    for (const payload of [{}, { userId: '' }, { userId: '   ' }, { userId: 42 }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().result).toBe('invalid_user');
    }
  });

  it('returns 404 when the sale does not exist', async () => {
    const orphan = buildApp({ saleId: 'does-not-exist', pool, redis });
    try {
      const res = await orphan.app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId: 'ghost' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().result).toBe('not_found');
    } finally {
      await orphan.app.close();
    }
  });

  it('race: 40 parallel attempts by the SAME user produce exactly one win', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 40 }, () => buy('racer')),
    );

    const purchased = statuses.filter((r) => r.statusCode === 201);
    const duplicates = statuses.filter((r) => r.statusCode === 409);
    expect(purchased).toHaveLength(1);
    expect(duplicates).toHaveLength(39);
    expect(statuses.every((r) => r.statusCode !== 500)).toBe(true);

    const stock = await readStock(pool, SALE_ID);
    expect(stock.soldCount).toBe(1);
    expect(stock.distinctPurchases).toBe(1);
  });

  it('race: overlapping same-user INSERTs surface as 409, never 500', async () => {
    // Force real transaction overlap (not just injection serialization) so the
    // INSERT ... WHERE NOT EXISTS blocks on the unique index and the loser
    // raises 23505. It must be mapped to already_purchased.
    const statuses = await Promise.all(
      Array.from({ length: 60 }, () => buy('hammer')),
    );
    const purchased = statuses.filter((r) => r.statusCode === 201);
    const duplicates = statuses.filter((r) => r.statusCode === 409);
    expect(purchased).toHaveLength(1);
    expect(duplicates).toHaveLength(59);
    expect(statuses.some((r) => r.statusCode === 500)).toBe(false);

    const stock = await readStock(pool, SALE_ID);
    expect(stock.soldCount).toBe(1);
    expect(stock.distinctPurchases).toBe(1);
  });

  it('race: 100 users vs stock 50 => exactly 50 winners, zero oversell', async () => {
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: 50 });
    await clearRedisKeysForSale(redis, SALE_ID);

    const statuses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => buy(`user-${i}`)),
    );

    const purchased = statuses.filter((r) => r.statusCode === 201);
    const soldOut = statuses.filter((r) => r.statusCode === 410);
    expect(purchased).toHaveLength(50);
    expect(soldOut).toHaveLength(50);

    const stock = await readStock(pool, SALE_ID);
    expect(stock.soldCount).toBe(50);
    expect(stock.distinctPurchases).toBe(50);

    const winnerIds = statuses
      .filter((r) => r.statusCode === 201)
      .map((r) => r.json().purchaseId);
    expect(new Set(winnerIds).size).toBe(50);
  });

  it('race: N users vs stock N always sells exactly N and lets each win once', async () => {
    const n = 40;
    await resetSale(pool, { saleId: SALE_ID, totalQuantity: n });
    await clearRedisKeysForSale(redis, SALE_ID);

    const statuses = await Promise.all(
      Array.from({ length: n }, (_, i) => buy(`full-${i}`)),
    );
    const purchased = statuses.filter((r) => r.statusCode === 201);
    expect(purchased).toHaveLength(n);

    const stock = await readStock(pool, SALE_ID);
    expect(stock.soldCount).toBe(n);
    expect(stock.distinctPurchases).toBe(n);

    const markers = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        app.inject({ method: 'GET', url: `/api/purchases/full-${i}` }),
      ),
    );
    expect(markers.every((r) => r.json().purchased === true)).toBe(true);
  });
});