import { Pool } from 'pg';
import { applySchema, seedSales } from '../src/db/schema';
import { config } from '../src/config';
import {
  awaitRedisReady,
  closeRedis,
  createAdvisoryRedis,
} from '../src/redis/client';
import type { Redis } from 'ioredis';

/** Drop the advisory keys of a re-armed sale. Reports instead of swallowing. */
async function flushSaleCache(redis: Redis, saleId: string): Promise<boolean> {
  try {
    const keys = await redis.keys(`sale:${saleId}:*`);
    if (keys.length > 0) await redis.del(...keys);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[migrate] could not flush advisory keys for ${saleId} (${reason}). ` +
        'The sale is re-armed in Postgres; a stale "purchased" flag may answer ' +
        '409 for a user id from the previous run.',
    );
    return false;
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  // Only needed when a closed demo sale gets re-armed: the advisory
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
    console.log('[migrate] demo sales: flash-sale-001, flash-sale-002, flash-sale-003');
    console.log('[migrate] tables: sales, purchases (one-per-user UNIQUE)');
    if (rearmed.length > 0) {
      console.log(
        `[migrate] re-armed closed sale(s) with a live window and cleared ` +
          `their purchases: ${rearmed.join(', ')}`,
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
