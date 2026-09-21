import { Pool } from 'pg';
import { applySchema, seedSales } from '../src/db/schema';
import { config } from '../src/config';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await applySchema(pool);
    await seedSales(pool, config);
    console.log('[migrate] schema applied');
    console.log(
      `[migrate] sale ${config.saleId} ready (${config.saleName}, ` +
        `${config.saleTotalQuantity} units @ ${config.salePriceCents} cents)`,
    );
    console.log('[migrate] demo sales: flash-sale-001, flash-sale-002, flash-sale-003');
    console.log('[migrate] tables: sales, purchases (one-per-user UNIQUE)');
  } finally {
    await pool.end();
  }
}

void main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});