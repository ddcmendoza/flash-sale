export interface StressConfig {
  baseUrl: string;
  databaseUrl: string;
  saleId: string;
  attempts: number;
  concurrency: number;
  /** The stock the sale is (re)seeded to before the run. */
  stock: number;
  /** Reset the sale to a clean state before firing attempts. */
  reset: boolean;
}

export function loadStressConfig(env: NodeJS.ProcessEnv = process.env): StressConfig {
  return {
    baseUrl: env.STRESS_BASE_URL ?? 'http://localhost:3000',
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://flash:flash@localhost:5433/flash_sale',
    saleId: env.SALE_ID ?? 'flash-sale-001',
    attempts: Number(env.STRESS_ATTEMPTS ?? 10_000),
    concurrency: Number(env.STRESS_CONCURRENCY ?? 200),
    stock: Number(env.SALE_TOTAL_QUANTITY ?? 1_000),
    reset: env.STRESS_RESET !== 'false',
  };
}

export const config = loadStressConfig();