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
 * multi-sale API and the web selector have something to show.
 *
 * A plain `ON CONFLICT DO NOTHING` is not enough, and the failure it causes is
 * nasty: the seed window is `now - 5m -> now + 60m`, so a demo sale expires an
 * hour after setup. On any machine that has run the project before - the second
 * clone, the next morning, a re-run of `db:migrate` - the rows are still there
 * with their windows closed, so the documented Getting Started sequence yields
 * three ENDED sales and a `410` from every Buy Now.
 *
 * So the seed is self-healing: if a demo sale exists and its window has already
 * closed, it is re-armed (window refreshed, `sold_count` zeroed, its purchases
 * removed) rather than left dead. A sale whose window is still live is left
 * completely alone, so re-running migrate mid-sale never disturbs it.
 *
 * Returns the ids that were re-armed, so the caller can flush their advisory
 * Redis keys - otherwise a previous run's `purchased` flags would hand out 409s
 * for purchase rows that no longer exist.
 */
export async function seedSales(pool: Pool, cfg: EnvConfig): Promise<string[]> {
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

  const rearmed: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sale of demos) {
      const startAt =
        sale.id === cfg.saleId
          ? defaultStartAt
          : new Date(now + sale.startOffsetMinutes * 60_000);
      const endAt =
        sale.id === cfg.saleId
          ? defaultEndAt
          : new Date(now + sale.endOffsetMinutes * 60_000);

      const refreshed = await client.query<{ id: string }>(
        `UPDATE sales
            SET name           = $2,
                price_cents    = $3,
                total_quantity = $4,
                sold_count     = 0,
                start_at       = $5,
                end_at         = $6,
                updated_at     = now()
          WHERE id = $1
            AND end_at <= now()
        RETURNING id`,
        [sale.id, sale.name, sale.priceCents, sale.totalQuantity, startAt, endAt],
      );

      if ((refreshed.rowCount ?? 0) > 0) {
        // A closed sale keeps its committed purchases; re-arming the window
        // without clearing them would leave sold_count=0 next to N rows and
        // break the invariant the stress harness checks.
        await client.query('DELETE FROM purchases WHERE sale_id = $1', [sale.id]);
        rearmed.push(sale.id);
        continue;
      }

      await client.query(
        `INSERT INTO sales (id, name, price_cents, total_quantity, sold_count, start_at, end_at)
         VALUES ($1, $2, $3, $4, 0, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [sale.id, sale.name, sale.priceCents, sale.totalQuantity, startAt, endAt],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return rearmed;
}