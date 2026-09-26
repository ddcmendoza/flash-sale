export type PurchaseMode = 'sync' | 'queue';

export interface EnvConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  saleId: string;
  saleName: string;
  salePriceCents: number;
  saleTotalQuantity: number;
  /** ISO timestamps; migrate.ts falls back to "now - 5m / now + 60m" when null. */
  saleStartAt: string | null;
  saleEndAt: string | null;
  purchaseMode: PurchaseMode;
  /**
   * pino level for the server process. Per-request lines are emitted at
   * `debug`, so the default `info` keeps the startup/shutdown/error lines and
   * drops the request trace — one 183k-request run used to write 360,390 log
   * lines with no way to turn them off. `LOG_LEVEL=debug` restores the full
   * trace, `LOG_LEVEL=warn` or `silent` makes the server quiet.
   */
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://flash:flash@localhost:5433/flash_sale',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    saleId: env.SALE_ID ?? 'flash-sale-001',
    saleName: env.SALE_NAME ?? 'Flash Drop — Limited Edition Watch',
    salePriceCents: Number(env.SALE_PRICE_CENTS ?? 19900),
    saleTotalQuantity: Number(env.SALE_TOTAL_QUANTITY ?? 1000),
    saleStartAt: env.SALE_START_AT ?? null,
    saleEndAt: env.SALE_END_AT ?? null,
    purchaseMode: env.PURCHASE_MODE === 'queue' ? 'queue' : 'sync',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

/** Read once at import; tests build their own instances via loadConfig/overrides. */
export const config: EnvConfig = loadConfig();