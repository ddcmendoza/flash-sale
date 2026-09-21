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
 * Seed a single sale row used for local development. Upsert so re-running
 * migrate never resets sold_count of an already-started demo.
 */
export async function seedSale(pool: Pool, cfg: EnvConfig): Promise<void> {
  const startAt = cfg.saleStartAt ?? new Date(Date.now() - 5 * 60_000);
  const endAt = cfg.saleEndAt ?? new Date(Date.now() + 60 * 60_000);

  await pool.query(
    `INSERT INTO sales (id, name, price_cents, total_quantity, sold_count, start_at, end_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      cfg.saleId,
      cfg.saleName,
      cfg.salePriceCents,
      cfg.saleTotalQuantity,
      startAt,
      endAt,
    ],
  );
}