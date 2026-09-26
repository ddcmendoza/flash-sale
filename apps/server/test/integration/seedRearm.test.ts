import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSales } from '../../src/db/schema';
import type { EnvConfig } from '../../src/config';
import {
  createTestPool,
  createTestRedis,
  deleteSale,
  readStock,
} from '../helpers/testDb';
import { closeRedis } from '../../src/redis/client';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

/**
 * `db:migrate` used to seed with `ON CONFLICT DO NOTHING`, which made the
 * documented Getting Started sequence produce a dead demo on any machine that
 * had run the project before: the seed window is now-5m -> now+60m, so an hour
 * later every demo sale exists with a closed window and the reviewer sees ENDED
 * everywhere and 410 from every Buy Now.
 *
 * The seed is now self-healing, and these tests pin both halves of that: a demo
 * sale that has drifted out of its seeded state is re-staged, and one already in
 * its seeded state is left strictly alone. The catalog is staged to show the
 * whole state machine — one ended, one live, one upcoming — so "re-staged" means
 * "put back in the state its own window describes", not "made live".
 */
describe('db:migrate seeds a demo that is always purchasable', () => {
  let pool: Pool;
  let redis: Redis;
  const saleIds = [
    'flash-sale-002',
    'flash-sale-003',
    'rearm-default',
    'rearm-pinned',
    'rearm-states',
  ];

  const cfg = (saleId: string, over: Partial<EnvConfig> = {}): EnvConfig => ({
    host: '0.0.0.0',
    port: 3000,
    databaseUrl: 'postgres://unused/unused',
    redisUrl: 'redis://unused:6379',
    saleId,
    saleName: 'Rearm Test Sale',
    salePriceCents: 19_900,
    saleTotalQuantity: 1_000,
    saleStartAt: null,
    saleEndAt: null,
    purchaseMode: 'sync',
    logLevel: 'info',
    ...over,
  });

  beforeAll(() => {
    pool = createTestPool();
    redis = createTestRedis();
  });

  afterAll(async () => {
    for (const saleId of saleIds) await deleteSale(pool, redis, saleId);
    await pool.end();
    await closeRedis(redis);
  });

  async function closeWindow(saleId: string): Promise<void> {
    await pool.query(
      `UPDATE sales SET start_at = now() - interval '3 hours',
                        end_at   = now() - interval '2 hours'
        WHERE id = $1`,
      [saleId],
    );
  }

  async function isLive(saleId: string): Promise<boolean> {
    const { rows } = await pool.query<{ live: boolean }>(
      'SELECT (start_at <= now() AND end_at >= now()) AS live FROM sales WHERE id = $1',
      [saleId],
    );
    return rows[0]?.live === true;
  }

  /**
   * The state each sale is in, straight from Postgres. The rule is spelled out
   * in SQL rather than reusing the app's resolver, so a bug in the resolver
   * cannot make a wrong seed look right.
   */
  async function readStates(ids: string[]): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ id: string; state: string }>(
      `SELECT id,
              CASE WHEN start_at > now()          THEN 'upcoming'
                   WHEN end_at < now()            THEN 'ended'
                   WHEN sold_count >= total_quantity THEN 'sold_out'
                   ELSE 'active'
              END AS state
         FROM sales
        WHERE id = ANY($1::text[])`,
      [ids],
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.state]));
  }

  it('re-arms a closed demo sale: live window, zeroed stock, no orphan rows', async () => {
    await seedSales(pool, cfg('rearm-default'));
    expect(await isLive('rearm-default')).toBe(true);

    // A previous run bought something, then the window closed.
    await pool.query(
      `INSERT INTO purchases (sale_id, user_id) VALUES ('rearm-default', 'old-buyer')
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `UPDATE sales SET sold_count = 1 WHERE id = 'rearm-default'`,
    );
    await closeWindow('rearm-default');
    expect(await isLive('rearm-default')).toBe(false);

    const rearmed = await seedSales(pool, cfg('rearm-default'));

    expect(rearmed).toContain('rearm-default');
    expect(await isLive('rearm-default')).toBe(true);
    // sold_count and rows must move together, or the stress harness's
    // `sold_count == purchase rows` invariant breaks.
    expect(await readStock(pool, 'rearm-default')).toMatchObject({
      soldCount: 0,
      totalQuantity: 1_000,
      distinctPurchases: 0,
    });
  });

  it('leaves a live sale completely alone, even with committed purchases', async () => {
    await seedSales(pool, cfg('rearm-default'));
    await pool.query(
      `INSERT INTO purchases (sale_id, user_id) VALUES ('rearm-default', 'live-buyer')
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `UPDATE sales SET sold_count = 1 WHERE id = 'rearm-default'`,
    );

    const rearmed = await seedSales(pool, cfg('rearm-default'));

    expect(rearmed).not.toContain('rearm-default');
    expect(await isLive('rearm-default')).toBe(true);
    // Re-running migrate mid-sale must not wipe a running demo.
    expect(await readStock(pool, 'rearm-default')).toMatchObject({
      soldCount: 1,
      distinctPurchases: 1,
    });
  });

  it('stages the fixed demo sales as ended and upcoming, and keeps them that way', async () => {
    await seedSales(pool, cfg('rearm-default'));

    // The catalog is the demo: one ended drop, one upcoming drop, and the
    // configured default live. `flash-sale-002` is deliberately ended, so the
    // old `WHERE end_at <= now()` re-arm would match it on every run and
    // resurrect it — that trap is the reason the refresh is scoped per sale.
    expect(await readStates(['flash-sale-002', 'flash-sale-003', 'rearm-default'])).toEqual({
      'flash-sale-002': 'ended',
      'flash-sale-003': 'upcoming',
      'rearm-default': 'active',
    });

    // Re-running with nothing stale touches nothing, ended sale included.
    expect(await seedSales(pool, cfg('rearm-default'))).toEqual([]);
    expect(await readStates(['flash-sale-002', 'flash-sale-003', 'rearm-default'])).toEqual({
      'flash-sale-002': 'ended',
      'flash-sale-003': 'upcoming',
      'rearm-default': 'active',
    });
  });

  it('re-stages a demo sale that drifted out of its seeded state', async () => {
    await seedSales(pool, cfg('rearm-default'));

    // Both staged sales opened up (hours later, the upcoming window arrived and
    // someone re-armed the ended one by hand) and the live sale went stale in
    // the other direction. Every one of them now sits in the wrong state.
    await pool.query(
      `UPDATE sales SET start_at = now() - interval '30 minutes',
                        end_at   = now() + interval '90 minutes'
        WHERE id IN ('flash-sale-002', 'flash-sale-003')`,
    );
    await pool.query(
      `UPDATE sales SET start_at = now() + interval '30 minutes',
                        end_at   = now() + interval '90 minutes'
        WHERE id = 'rearm-default'`,
    );

    const rearmed = await seedSales(pool, cfg('rearm-default'));

    expect(rearmed).toEqual(
      expect.arrayContaining(['flash-sale-002', 'flash-sale-003', 'rearm-default']),
    );
    expect(await readStates(['flash-sale-002', 'flash-sale-003', 'rearm-default'])).toEqual({
      'flash-sale-002': 'ended',
      'flash-sale-003': 'upcoming',
      'rearm-default': 'active',
    });
  });

  it('never stages sold_count: a seeded sale has no sales data to show', async () => {
    await seedSales(pool, cfg('rearm-states'));

    // Timing is staged, sales data is not. An ended drop honestly shows 0 sold.
    for (const saleId of ['rearm-states', 'flash-sale-002', 'flash-sale-003']) {
      expect(await readStock(pool, saleId)).toMatchObject({
        soldCount: 0,
        distinctPurchases: 0,
      });
    }
  });

  it('is idempotent: a second run with nothing stale changes nothing', async () => {
    await seedSales(pool, cfg('rearm-default'));
    const first = await seedSales(pool, cfg('rearm-default'));
    const second = await seedSales(pool, cfg('rearm-default'));

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(await isLive('rearm-default')).toBe(true);
  });

  it('honours a pinned window instead of computing one', async () => {
    // A fresh id, so this exercises the insert path with the pinned values
    // rather than the re-stage path (which only fires on an existing row that
    // has drifted out of its seeded state).
    const startAt = new Date(Date.now() - 60_000);
    const endAt = new Date(Date.now() + 3_600_000);
    await seedSales(
      pool,
      cfg('rearm-pinned', { saleStartAt: startAt.toISOString(), saleEndAt: endAt.toISOString() }),
    );
    const { rows } = await pool.query<{ start_at: Date; end_at: Date }>(
      'SELECT start_at, end_at FROM sales WHERE id = $1',
      ['rearm-pinned'],
    );
    expect(rows[0]!.start_at.getTime()).toBe(startAt.getTime());
    expect(rows[0]!.end_at.getTime()).toBe(endAt.getTime());
  });
});
