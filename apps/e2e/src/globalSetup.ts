import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { env } from './helpers/env';

const DEMO_SALES = [
  {
    id: 'flash-sale-001',
    name: 'Flash Drop — Limited Edition Watch',
    priceCents: 19900,
    totalQuantity: 1000,
  },
  {
    id: 'flash-sale-002',
    name: 'Tech Drop — Wireless Earbuds Pro',
    priceCents: 9900,
    totalQuantity: 500,
  },
  {
    id: 'flash-sale-003',
    name: 'Fashion Flash — Limited Edition Sneaker',
    priceCents: 24900,
    totalQuantity: 250,
  },
];

/**
 * Runs once before the worker processes: puts the shared DB in a clean,
 * deterministic state and flushes the advisory Redis cache for the demo sales.
 * Doesn't drop or recreate schema — that is `db:migrate`'s job (wired into the
 * root `test:e2e` script).
 */
export default async function globalSetup(): Promise<void> {
  const cfg = env();
  const pool = new Pool({ connectionString: cfg.dbUrl, max: 5 });

  // Sweep leftovers from previous runs so /api/sales stays clean.
  await pool.query("DELETE FROM purchases WHERE sale_id LIKE 'e2e-%'");
  await pool.query("DELETE FROM sales WHERE id LIKE 'e2e-%'");

  // Re-arm each demo sale to a known, live state (idempotent upsert).
  for (const s of DEMO_SALES) {
    await pool.query(
      `INSERT INTO sales (id, name, price_cents, total_quantity, sold_count, start_at, end_at)
       VALUES ($1, $2, $3, $4, 0, now() - interval '5 minutes', now() + interval '60 minutes')
       ON CONFLICT (id) DO UPDATE SET
         name           = EXCLUDED.name,
         price_cents    = EXCLUDED.price_cents,
         total_quantity = EXCLUDED.total_quantity,
         sold_count     = 0,
         start_at       = EXCLUDED.start_at,
         end_at         = EXCLUDED.end_at`,
      [s.id, s.name, s.priceCents, s.totalQuantity],
    );
  }
  await pool.end();

  // Flush the advisory Redis fast-path so stale counters can't leak into the
  // first assertions (it would self-heal within ~1s anyway).
  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  try {
    for (const s of DEMO_SALES) {
      const keys = await redis.keys(`sale:${s.id}:*`);
      if (keys.length > 0) await redis.del(keys);
    }
  } finally {
    redis.disconnect();
  }
}