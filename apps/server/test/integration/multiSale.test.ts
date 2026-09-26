import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { get } from 'node:http';
import { buildApp } from '../../src/app';
import { closeRedis } from '../../src/redis/client';
import {
  createTestPool,
  createTestRedis,
  resetSale,
  clearRedisKeysForSale,
  deleteSale,
  readStock,
} from '../helpers/testDb';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { SaleStatusResponse } from '@flash-sale/shared';

const DEFAULT_ID = 'it-multi-default';
const OTHER_ID = 'it-multi-other';

describe('multi-sale catalog + per-sale isolation + SSE live stream', () => {
  let pool: Pool;
  let redis: Redis;
  let app: FastifyInstance;
  let baseUrl: string;
  const created: string[] = [];

  beforeAll(async () => {
    pool = createTestPool();
    redis = createTestRedis();
    const built = buildApp({ saleId: DEFAULT_ID, pool, redis });
    app = built.app;
    await app.ready();
    await app.liveBus.start();
    await app.listen({ port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    for (const saleId of created) {
      await deleteSale(pool, saleId);
    }
    await pool.end();
    await closeRedis(redis);
  });

  async function freshSale(id: string, totalQuantity = 10): Promise<string> {
    const saleId = await resetSale(pool, { saleId: id, totalQuantity });
    await clearRedisKeysForSale(redis, saleId);
    created.push(saleId);
    return saleId;
  }

  it('lists every sale in the catalog', async () => {
    await freshSale(DEFAULT_ID);
    await freshSale(OTHER_ID);

    const res = await fetch(`${baseUrl}/api/sales`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { sales: Array<{ id: string }> };
    const ids = body.sales.map((s) => s.id);
    expect(ids).toContain(DEFAULT_ID);
    expect(ids).toContain(OTHER_ID);
  });

  it('keeps one-per-user scoped per sale: a win on sale A does not block sale B', async () => {
    await freshSale(DEFAULT_ID);
    await freshSale(OTHER_ID);

    const buy = (saleId: string, userId: string) =>
      fetch(`${baseUrl}/api/sales/${saleId}/purchase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });

    const a = await buy(DEFAULT_ID, 'cross-sale-user');
    expect(a.status).toBe(201);

    const b = await buy(OTHER_ID, 'cross-sale-user');
    expect(b.status).toBe(201);

    // Status/stock are per sale and independent.
    const sa = (await (
      await fetch(`${baseUrl}/api/sales/${DEFAULT_ID}/status`)
    ).json()) as SaleStatusResponse;
    const sb = (await (
      await fetch(`${baseUrl}/api/sales/${OTHER_ID}/status`)
    ).json()) as SaleStatusResponse;
    expect(sa.soldCount).toBe(1);
    expect(sb.soldCount).toBe(1);

    // The legacy alias answers for the default sale only.
    const legacy = (await (
      await fetch(`${baseUrl}/api/purchases/cross-sale-user`)
    ).json()) as { purchased: boolean; saleId: string };
    expect(legacy.purchased).toBe(true);
    expect(legacy.saleId).toBe(DEFAULT_ID);
    const otherCheck = (await (
      await fetch(`${baseUrl}/api/sales/${OTHER_ID}/purchases/cross-sale-user`)
    ).json()) as { purchased: boolean; saleId: string };
    expect(otherCheck.purchased).toBe(true);
    expect(otherCheck.saleId).toBe(OTHER_ID);
  });

  it('pushes a live frame over SSE after a purchase commits', async () => {
    const saleId = await freshSale('it-multi-sse', 10);
    const seller = 'sse-witness';

    const frames: SaleStatusResponse[] = [];
    const close = openEvents(
      `${baseUrl}/api/sales/${saleId}/events`,
      (_name, data) => {
        frames.push(JSON.parse(data) as SaleStatusResponse);
      },
    );

    try {
      // Initial snapshot arrives on connect.
      await waitFor(() => frames.length >= 1);

      const res = await fetch(`${baseUrl}/api/sales/${saleId}/purchase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: seller }),
      });
      expect(res.status).toBe(201);

      // The purchase path publishes instantly; wait for soldCount to bump.
      await waitFor(() => frames.some((f) => f.soldCount >= 1), 5_000);

      const latest = frames[frames.length - 1]!;
      expect(latest.saleId).toBe(saleId);
      expect(latest.soldCount).toBe(1);
      expect((await readStock(pool, saleId)).soldCount).toBe(1);
    } finally {
      close();
    }
  });

  it('reconciles a window flip to the SSE stream (upcoming → active)', async () => {
    const saleId = await resetSale(pool, {
      saleId: 'it-multi-flip',
      totalQuantity: 10,
      startAt: new Date(Date.now() + 1_500),
      endAt: new Date(Date.now() + 10 * 60_000),
    });
    await clearRedisKeysForSale(redis, saleId);
    created.push(saleId);

    const statuses: SaleStatusResponse['status'][] = [];
    const close = openEvents(
      `${baseUrl}/api/sales/${saleId}/events`,
      (_name, data) => {
        statuses.push((JSON.parse(data) as SaleStatusResponse).status);
      },
    );

    try {
      // The 1s reconciler must observe the window opening without a purchase.
      await waitFor(() => statuses.includes('active'), 10_000);
      expect(statuses[0]).toBe('upcoming');
    } finally {
      close();
    }
  });
});

/** Minimal SSE client: GET the URL and dispatch parsed `event`/`data` frames.
 * Heartbeat comment frames (`: ping`) are ignored. */
function openEvents(
  url: string,
  onEvent: (name: string, data: string) => void,
): () => void {
  const req = get(url, (res) => {
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let name = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) onEvent(name, data);
      }
    });
  });
  req.on('error', () => {});
  return () => req.destroy();
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for condition');
}