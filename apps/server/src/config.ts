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
  };
}

/** Read once at import; tests build their own instances via loadConfig/overrides. */
export const config: EnvConfig = loadConfig();