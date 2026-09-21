import { Pool } from 'pg';
import { applySchema, seedSale } from '../src/db/schema';
import { config } from '../src/config';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await applySchema(pool);
    await seedSale(pool, config);
    console.log('[migrate] schema applied');
    console.log(
      `[migrate] sale ${config.saleId} ready (${config.saleName}, ` +
        `${config.saleTotalQuantity} units @ ${config.salePriceCents} cents)`,
    );
    console.log('[migrate] tables: sales, purchases (one-per-user UNIQUE)');
  } finally {
    await pool.end();
  }
}

void main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});