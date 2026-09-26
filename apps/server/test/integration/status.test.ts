import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SaleStatusResponse } from '@flash-sale/shared';
import { buildApp } from '../../src/app';
import { closeRedis } from '../../src/redis/client';
import {
  createTestPool,
  createTestRedis,
  resetSale,
  clearRedisKeysForSale,
  deleteSale,
} from '../helpers/testDb';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

describe('GET /api/sale/status', () => {
  let pool: Pool;
  let redis: Redis;
  const created: string[] = [];

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
  });

  afterAll(async () => {
    for (const saleId of created) {
      await deleteSale(pool, redis, saleId);
    }
    await pool.end();
    await closeRedis(redis);
  });

  async function statusFor(
    saleId: string,
  ): Promise<{ code: number; body: SaleStatusResponse }> {
    created.push(saleId);
    const { app } = buildApp({ saleId, pool, redis });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/sale/status' });
      return { code: res.statusCode, body: res.json() as SaleStatusResponse };
    } finally {
      await app.close();
    }
  }

  it('reports upcoming for a future window', async () => {
    const saleId = await resetSale(pool, {
      startAt: new Date(Date.now() + 60 * 60_000),
      endAt: new Date(Date.now() + 2 * 60 * 60_000),
    });
    const { code, body } = await statusFor(saleId);
    expect(code).toBe(200);
    expect(body.status).toBe('upcoming');
    expect(body.remaining).toBe(body.totalQuantity);
  });

  it('reports active while the window is open with stock', async () => {
    const saleId = await resetSale(pool, { totalQuantity: 50 });
    const { code, body } = await statusFor(saleId);
    expect(code).toBe(200);
    expect(body.status).toBe('active');
    expect(body.remaining).toBe(50);
  });

  it('reports sold_out when stock is exhausted inside the window', async () => {
    const saleId = await resetSale(pool, { totalQuantity: 3 });
    created.push(saleId);
    const { app } = buildApp({ saleId, pool, redis });
    try {
      for (const user of ['a', 'b', 'c']) {
        await app.inject({
          method: 'POST',
          url: '/api/purchase',
          payload: { userId: user },
        });
      }
      await clearRedisKeysForSale(redis, saleId);
      const res = await app.inject({ method: 'GET', url: '/api/sale/status' });
      expect((res.json() as SaleStatusResponse).status).toBe('sold_out');
      expect((res.json() as SaleStatusResponse).remaining).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('reports ended after end_at', async () => {
    const saleId = await resetSale(pool, {
      startAt: new Date(Date.now() - 2 * 60 * 60_000),
      endAt: new Date(Date.now() - 60 * 60_000),
    });
    const { code, body } = await statusFor(saleId);
    expect(code).toBe(200);
    expect(body.status).toBe('ended');
  });

  it('reflects stock that is currently reserved', async () => {
    const saleId = await resetSale(pool, { totalQuantity: 10 });
    created.push(saleId);
    const { app } = buildApp({ saleId, pool, redis });
    try {
      await app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId: 'status-checker' },
      });
      await clearRedisKeysForSale(redis, saleId);
      const res = await app.inject({ method: 'GET', url: '/api/sale/status' });
      const body = res.json() as SaleStatusResponse;
      expect(body.soldCount).toBe(1);
      expect(body.remaining).toBe(9);
    } finally {
      await app.close();
    }
  });
});