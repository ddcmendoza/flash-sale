import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { resolveSaleStatus } from '@flash-sale/shared';
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
 * The window state a seeded demo sale is *meant* to be in, as the API reports
 * it. `sold_out` is not a seed target: it is a property of stock, not of the
 * window, and staging it would mean inventing sales data.
 */
type StagedState = 'active' | 'ended' | 'upcoming';

/**
 * Which state the window `startAt -> endAt` describes at `now`, using the same
 * resolver the API uses so the seed and `GET /api/sales/:id/status` can never
 * disagree about what a sale is. `sold_out` collapses into `active` here: it is
 * an in-window state, and a zero-stock sale must not be rewritten on every run.
 */
function stagedState(
  startAt: Date,
  endAt: Date,
  now: Date,
  totalQuantity: number,
): StagedState {
  const status = resolveSaleStatus({ startAt, endAt, soldCount: 0, totalQuantity }, now);
  return status === 'ended' || status === 'upcoming' ? status : 'active';
}

/**
 * Seed the configured default sale plus a few extra demo sales so the
 * multi-sale API and the web selector have something to show.
 *
 * The catalog deliberately shows the whole state machine: exactly one ENDED
 * drop, one LIVE drop, and one UPCOMING drop, so a reviewer landing on the page
 * sees all three states without having to wait for one. Only the timing is
 * staged - no seeded sale carries invented `sold_count`, so an ended drop
 * honestly shows 0 sold.
 *
 * A plain `ON CONFLICT DO NOTHING` is not enough, and the failure it causes is
 * nasty: the seed window is `now - 5m -> now + 60m`, so a demo sale expires an
 * hour after setup. On any machine that has run the project before - the second
 * clone, the next morning, a re-run of `db:migrate` - the rows are still there
 * with their windows closed, so the documented Getting Started sequence yields
 * three ENDED sales and a `410` from every Buy Now.
 *
 * So the seed is self-healing: a sale is re-staged (window refreshed,
 * `sold_count` zeroed, its purchases removed) whenever the row is not already
 * in the state its own window describes - which covers both the dead demo sale
 * above and a live sale that has drifted out of the state it should be in.
 *
 * That condition is per sale, and that is the whole trick. A single global
 * `WHERE end_at <= now()` cannot be used here: a deliberately ENDED sale has a
 * closed window by definition, so that predicate matches it and migrate
 * resurrects it to live on the next run. The seed would look right once and
 * then quietly drift back to three live sales. Each sale is therefore compared
 * against the state its own window describes, and a sale already in that state
 * is left strictly alone - so re-running migrate never disturbs a running demo
 * (the live sale) and never resurrects the staged ended one.
 *
 * One consequence worth stating: because a staged sale is reconciled on every
 * run, an UPCOMING sale whose window has since opened is pushed back to
 * upcoming, which drops any purchases made during that window. That is the
 * price of the guarantee "one of each state after any migrate", and it only
 * ever touches the two staged sales - the live sale is the one people buy from.
 *
 * Returns the ids that were re-staged, so the caller can flush their advisory
 * Redis keys - otherwise a previous run's `purchased` flags would hand out 409s
 * for purchase rows that no longer exist.
 */
export async function seedSales(pool: Pool, cfg: EnvConfig): Promise<string[]> {
  const now = Date.now();
  const defaultStartAt = cfg.saleStartAt
    ? new Date(cfg.saleStartAt)
    : new Date(now - 5 * 60_000);
  const defaultEndAt = cfg.saleEndAt ? new Date(cfg.saleEndAt) : new Date(now + 60 * 60_000);

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
      // ENDED on purpose: this is the sale the reviewer sees refusing buys
      // with 410. Its window is a few hours in the past so the catalog shows a
      // finished drop rather than one that ended a minute ago.
      id: 'flash-sale-002',
      name: 'Tech Drop — Wireless Earbuds Pro',
      priceCents: 9_900,
      totalQuantity: 500,
      startOffsetMinutes: -180,
      endOffsetMinutes: -120,
    },
    {
      // UPCOMING on purpose: the 425 case, and the sale whose window has to
      // outlast a reviewer's coffee break. A day of lead time means it is
      // still `starts soon` when someone first opens the demo, not elapsed.
      id: 'flash-sale-003',
      name: 'Fashion Flash — Limited Edition Sneaker',
      priceCents: 24_900,
      totalQuantity: 250,
      startOffsetMinutes: +120,
      endOffsetMinutes: +1_560,
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

      // The state this sale is *meant* to be in, derived from its own window so
      // the two can never drift apart. Compared against Postgres `now()` in the
      // UPDATE below, not against the client clock.
      const state = stagedState(startAt, endAt, new Date(now), sale.totalQuantity);

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
            AND NOT (
              ($7 = 'ended'    AND end_at <= now()) OR
              ($7 = 'upcoming' AND start_at > now()) OR
              ($7 = 'active'   AND start_at <= now() AND end_at > now())
            )
        RETURNING id`,
        [sale.id, sale.name, sale.priceCents, sale.totalQuantity, startAt, endAt, state],
      );

      if ((refreshed.rowCount ?? 0) > 0) {
        // A re-staged sale drops its committed purchases: the purchases belong
        // to the window it just left, and keeping them would leave
        // sold_count=0 next to N rows and break the invariant the stress
        // harness checks.
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