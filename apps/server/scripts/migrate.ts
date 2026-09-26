import { Pool } from 'pg';
import { resolveSaleStatus } from '@flash-sale/shared';
import { applySchema, seedSales } from '../src/db/schema';
import { config } from '../src/config';
import { toSnapshot, type SaleRow } from '../src/repos/sales';
import {
  awaitRedisReady,
  closeRedis,
  createAdvisoryRedis,
} from '../src/redis/client';
import type { Redis } from 'ioredis';

/** Drop the advisory keys of a re-staged sale. Reports instead of swallowing. */
async function flushSaleCache(redis: Redis, saleId: string): Promise<boolean> {
  try {
    const keys = await redis.keys(`sale:${saleId}:*`);
    if (keys.length > 0) await redis.del(...keys);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[migrate] could not flush advisory keys for ${saleId} (${reason}). ` +
        'The sale is re-staged in Postgres; a stale "purchased" flag may answer ' +
        '409 for a user id from the previous run.',
    );
    return false;
  }
}

/**
 * Read the seeded sales back and print the state each one resolves to, oldest
 * window first. The seed promises a catalog showing all three states, so a
 * migrate run is its own proof of that: no second command, no psql, and the
 * state comes from the same resolver the API answers `/api/sales` with.
 */
async function printSeededStates(pool: Pool): Promise<void> {
  const { rows } = await pool.query<SaleRow>(
    `SELECT id, start_at, end_at, sold_count, total_quantity
       FROM sales
      WHERE id = ANY($1::text[])
      ORDER BY start_at`,
    [[config.saleId, 'flash-sale-002', 'flash-sale-003']],
  );
  const now = new Date();
  const lines = rows.map((row) => `  ${row.id}  ${resolveSaleStatus(toSnapshot(row), now)}`);
  console.log(
    `[migrate] demo catalog, one ended + one live + one upcoming:\n${lines.join('\n')}`,
  );
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  // Only needed when a demo sale gets re-staged: the advisory
  // `purchased` flags from the previous run would otherwise answer 409 for
  // purchase rows that no longer exist. Best effort - a missing cache must not
  // fail the migration, but a failure here is reported.
  let redis: Redis | null = null;
  try {
    await applySchema(pool);
    const rearmed = await seedSales(pool, config);
    if (rearmed.length > 0) {
      redis = createAdvisoryRedis(config.redisUrl, 'migrate');
      // Fail-fast advisory options reject commands issued before the socket is
      // up, so wait for the connection before the first `keys()`.
      await awaitRedisReady(redis);
      for (const saleId of rearmed) {
        await flushSaleCache(redis, saleId);
      }
    }

    console.log('[migrate] schema applied');
    console.log(
      `[migrate] sale ${config.saleId} ready (${config.saleName}, ` +
        `${config.saleTotalQuantity} units @ ${config.salePriceCents} cents)`,
    );
    console.log('[migrate] tables: sales, purchases (one-per-user UNIQUE)');
    await printSeededStates(pool);
    if (rearmed.length > 0) {
      console.log(
        `[migrate] re-staged sale(s) whose window no longer matched the seeded ` +
          `state, and cleared their purchases: ${rearmed.join(', ')}`,
      );
    }
  } finally {
    if (redis) await closeRedis(redis);
    await pool.end();
  }
}

void main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
