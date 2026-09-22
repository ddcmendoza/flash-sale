export interface E2EEnv {
  apiUrl: string;
  webUrl: string;
  dbUrl: string;
  redisUrl: string;
}

/** Shared env resolution; call once per process. */
export function env(): E2EEnv {
  return {
    apiUrl: process.env.E2E_API_URL ?? 'http://localhost:3000',
    webUrl: process.env.E2E_WEB_URL ?? 'http://localhost:5173',
    dbUrl: process.env.E2E_DB_URL ?? 'postgres://flash:flash@localhost:5433/flash_sale',
    redisUrl: process.env.E2E_REDIS_URL ?? 'redis://localhost:6379',
  };
}