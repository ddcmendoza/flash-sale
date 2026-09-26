import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../src/app';
import { closeRedis } from '../../src/redis/client';
import { createTestPool, createTestRedis, deleteSale, readStock } from '../helpers/testDb';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type {
  AdminSaleInput,
  AdminSaleMutationResponse,
  AdminSalesListResponse,
  AdminSaleRecord,
} from '@flash-sale/shared';

describe('admin management API', () => {
  let pool: Pool;
  let redis: Redis;
  let app: FastifyInstance;
  let baseUrl: string;
  const created: string[] = [];

  const newSaleInput = (overrides: Partial<AdminSaleInput> = {}): AdminSaleInput => ({
    name: overrides.name ?? 'Admin Test Drop',
    priceCents: overrides.priceCents ?? 24999,
    totalQuantity: overrides.totalQuantity ?? 10,
    startAt: overrides.startAt ?? new Date(Date.now() - 60_000).toISOString(),
    endAt: overrides.endAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    ...(overrides.id ? { id: overrides.id } : {}),
  });

  beforeAll(async () => {
    pool = createTestPool();
    redis = createTestRedis();
    const built = buildApp({ saleId: 'admin-default', pool, redis });
    app = built.app;
    await app.ready();
    await app.liveBus.start();
    await app.listen({ port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    for (const saleId of created) await deleteSale(pool, redis, saleId);
    await pool.end();
    await closeRedis(redis);
  });

  async function createSale(
    body: object,
    expected = 201,
  ): Promise<AdminSaleRecord | null> {
    const res = await fetch(`${baseUrl}/api/admin/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(expected);
    if (expected !== 201) return null;
    const parsed = (await res.json()) as AdminSaleMutationResponse;
    created.push(parsed.sale.id);
    return parsed.sale;
  }

  it('creates a sale and returns a fully-formed record', async () => {
    const sale = (await createSale(newSaleInput({ id: `admin-create-${randomUUID().slice(0, 6)}` })))!;

    expect(sale.name).toBe('Admin Test Drop');
    expect(sale.priceCents).toBe(24999);
    expect(sale.totalQuantity).toBe(10);
    expect(sale.soldCount).toBe(0);
    expect(sale.remaining).toBe(10);
    expect(sale.purchaseCount).toBe(0);
    expect(sale.status).toBe('active');
    expect(new Date(sale.startAt)).toBeInstanceOf(Date);
    expect(new Date(sale.endAt)).toBeInstanceOf(Date);

    const list = (await (await fetch(`${baseUrl}/api/admin/sales`)).json()) as AdminSalesListResponse;
    expect(list.sales.some((s) => s.id === sale.id)).toBe(true);
  });

  it('generates an id when none is supplied', async () => {
    const sale = (await createSale(newSaleInput()))!;
    expect(sale.id.startsWith('flash-sale-')).toBe(true);
  });

  it('rejects duplicate ids, invalid bodies and windows', async () => {
    const sale = (await createSale(newSaleInput()))!;
    await createSale(newSaleInput({ id: sale.id, name: 'dup' }), 409);

    await createSale(newSaleInput({ name: '   ' }), 400);
    await createSale(newSaleInput({ priceCents: 0 }), 400);
    await createSale(newSaleInput({ totalQuantity: 0 }), 400);
    await createSale(newSaleInput({ startAt: 'not-a-date' }), 400);
    await createSale(
      newSaleInput({ endAt: new Date(Date.now() - 120_000).toISOString() }),
      400,
    );
  });

  it('reflects purchase activity and rejects quantity below sold count', async () => {
    const sale = (await createSale(newSaleInput({ totalQuantity: 2 })))!;

    const u1 = 'admin-user-1';
    const u2 = 'admin-user-2';
    await fetch(`${baseUrl}/api/sales/${sale.id}/purchase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: u1 }),
    });
    await fetch(`${baseUrl}/api/sales/${sale.id}/purchase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: u2 }),
    });

    const stock = await readStock(pool, sale.id);
    expect(stock.soldCount).toBe(2);
    expect(stock.distinctPurchases).toBe(2);

    const overRestock = await fetch(`${baseUrl}/api/admin/sales/${sale.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totalQuantity: 1 }),
    });
    expect(overRestock.status).toBe(400);

    const purchases = (await (
      await fetch(`${baseUrl}/api/admin/sales/${sale.id}/purchases`)
    ).json()) as { purchases: { userId: string }[] };
    expect(purchases.purchases.map((p) => p.userId).sort()).toEqual([u1, u2]);
  });

  it('patches a sale and pushes the change into the public status endpoint', async () => {
    const sale = (await createSale(newSaleInput()))!;

    const res = await fetch(`${baseUrl}/api/admin/sales/${sale.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Drop', priceCents: 500 }),
    });
    expect(res.status).toBe(200);
    const { sale: updated } = (await res.json()) as AdminSaleMutationResponse;
    expect(updated.name).toBe('Renamed Drop');
    expect(updated.priceCents).toBe(500);

    const status = (await (await fetch(`${baseUrl}/api/sales/${sale.id}/status`)).json()) as {
      name: string;
      priceCents: number;
    };
    expect(status.name).toBe('Renamed Drop');
    expect(status.priceCents).toBe(500);

    const missing = await fetch(`${baseUrl}/api/admin/sales/no-such-sale`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(missing.status).toBe(404);
  });

  it('reset wipes purchases and clears the repeat-buyer fast path', async () => {
    const sale = (await createSale(newSaleInput()))!;
    const user = 'admin-reset-user';

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/api/sales/${sale.id}/purchase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: user }),
      });
      expect(res.status).toBe(i === 0 ? 201 : 409);
    }

    const reset = await fetch(`${baseUrl}/api/admin/sales/${sale.id}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(200);
    const { sale: resetSale } = (await reset.json()) as AdminSaleMutationResponse;
    expect(resetSale.soldCount).toBe(0);
    expect(resetSale.purchaseCount).toBe(0);

    const stock = await readStock(pool, sale.id);
    expect(stock.soldCount).toBe(0);
    expect(stock.distinctPurchases).toBe(0);

    // Same user can buy again: the purchased fast-path keys were flushed.
    const again = await fetch(`${baseUrl}/api/sales/${sale.id}/purchase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user }),
    });
    expect(again.status).toBe(201);
  });

  it('deletes a sale, its purchases, and its catalog entry', async () => {
    const sale = (await createSale(newSaleInput()))!;
    await fetch(`${baseUrl}/api/sales/${sale.id}/purchase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'delete-me' }),
    });

    const res = await fetch(`${baseUrl}/api/admin/sales/${sale.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const list = (await (await fetch(`${baseUrl}/api/admin/sales`)).json()) as AdminSalesListResponse;
    expect(list.sales.some((s) => s.id === sale.id)).toBe(false);

    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM sales WHERE id = $1',
      [sale.id],
    );
    expect(rows).toHaveLength(0);
    const purchaseRows = await pool.query(
      'SELECT id FROM purchases WHERE sale_id = $1',
      [sale.id],
    );
    expect(purchaseRows.rows).toHaveLength(0);

    const purchases = await fetch(`${baseUrl}/api/admin/sales/${sale.id}/purchases`);
    expect(purchases.status).toBe(404);

    const again = await fetch(`${baseUrl}/api/admin/sales/${sale.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});