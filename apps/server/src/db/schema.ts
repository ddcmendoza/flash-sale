import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { EnvConfig } from '../config';

/**
 * Apply `infra/db/schema.sql`. Idempotent (all DDL is CREATE IF NOT EXISTS),
 * so migrate and the test bootstrap share one path.
 */
export async function applySchema(pool: Pool): Promise<void> {
  const sql = await readFile(schemaPath(), 'utf8');
  await pool.query(sql);
}

function schemaPath(): string {
  return new URL('../../../../infra/db/schema.sql', import.meta.url).pathname;
}

/**
 * Seed the configured default sale plus a few extra demo sales so the
 * multi-sale API and the web selector have something to show. Upserts so
 * re-running migrate never resets sold_count of an already-started demo.
 */
export async function seedSales(pool: Pool, cfg: EnvConfig): Promise<void> {
  const now = Date.now();
  const defaultStartAt = cfg.saleStartAt ?? new Date(now - 5 * 60_000);
  const defaultEndAt = cfg.saleEndAt ?? new Date(now + 60 * 60_000);

  const demos: Array<{
    id: string;
    name: string;
    priceCents: number;
    totalQuantity: number;
    startOffsetMinutes: number;
    endOffsetMinutes: number;
  }> = [
    {
      id: cfg.saleId,
      name: cfg.saleName,
      priceCents: cfg.salePriceCents,
      totalQuantity: cfg.saleTotalQuantity,
      startOffsetMinutes: -5,
      endOffsetMinutes: +60,
    },
    {
      id: 'flash-sale-002',
      name: 'Tech Drop — Wireless Earbuds Pro',
      priceCents: 9_900,
      totalQuantity: 500,
      startOffsetMinutes: -30,
      endOffsetMinutes: +90,
    },
    {
      id: 'flash-sale-003',
      name: 'Fashion Flash — Limited Edition Sneaker',
      priceCents: 24_900,
      totalQuantity: 250,
      startOffsetMinutes: -12,
      endOffsetMinutes: +45,
    },
  ];

  for (const sale of demos) {
    const startAt = sale.id === cfg.saleId ? defaultStartAt : new Date(now + sale.startOffsetMinutes * 60_000);
    const endAt = sale.id === cfg.saleId ? defaultEndAt : new Date(now + sale.endOffsetMinutes * 60_000);
    await pool.query(
      `INSERT INTO sales (id, name, price_cents, total_quantity, sold_count, start_at, end_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        sale.id,
        sale.name,
        sale.priceCents,
        sale.totalQuantity,
        startAt,
        endAt,
      ],
    );
  }
}