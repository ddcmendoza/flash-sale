import fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { Pool, type PoolConfig } from 'pg';
import { Redis } from 'ioredis';
import { config, type EnvConfig, type PurchaseMode } from './config';
import { pgPlugin } from './plugins/pg';
import { redisPlugin } from './plugins/redis';
import { servicesPlugin } from './plugins/services';
import { healthRoutes } from './routes/health';
import { saleStatusRoutes } from './routes/saleStatus';
import { purchaseRoutes } from './routes/purchase';
import { purchasesRoutes } from './routes/purchases';
import { SalesRepo } from './repos/sales';
import { PurchasesRepo } from './repos/purchases';
import { PurchaseService } from './services/purchaseService';
import { SaleStatusService, PurchaseGate } from './services/saleStatusService';
import {
  BullPurchaseProducer,
  createPurchaseQueue,
  type PurchaseProducer,
} from './queue/producer';
import {
  startPurchaseWorker,
  type PurchaseWorkerHandle,
} from './queue/worker';

export interface BuildAppOptions {
  saleId?: string;
  purchaseMode?: PurchaseMode;
  /** Inject for tests / custom pools. When omitted, built from config. */
  pool?: Pool;
  redis?: Redis;
  /** Injectable clock, used only for failure classification, not the PG guard. */
  now?: () => Date;
  logger?: boolean | FastifyServerOptions['logger'];
  poolConfig?: PoolConfig;
}

export interface BuiltApp {
  app: FastifyInstance;
  pool: Pool;
  redis: Redis;
  worker?: PurchaseWorkerHandle;
}

export function buildApp(opts: BuildAppOptions = {}): BuiltApp {
  const cfg: EnvConfig = {
    ...config,
    ...(opts.saleId ? { saleId: opts.saleId } : {}),
    ...(opts.purchaseMode ? { purchaseMode: opts.purchaseMode } : {}),
  };

  const ownedPool = opts.pool === undefined;
  const ownedRedis = opts.redis === undefined;
  const pool = opts.pool ?? new Pool({ connectionString: cfg.databaseUrl, ...opts.poolConfig });
  const redis = opts.redis ?? new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });

  const app: FastifyInstance = fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
  });

  app.register(pgPlugin, { pool, closeOnClose: ownedPool });
  app.register(redisPlugin, { redis, closeOnClose: ownedRedis });

  const salesRepo = new SalesRepo(pool);
  const purchasesRepo = new PurchasesRepo(pool);
  const now = opts.now ?? (() => new Date());
  const saleStatusService = new SaleStatusService(salesRepo, redis, cfg.saleId);
  const purchaseGate = new PurchaseGate(redis, saleStatusService, cfg.saleId);
  const purchaseService = new PurchaseService(pool, cfg.saleId, now);

  // Queue wiring. In sync mode a stub producer is decorated so the single
  // route code path stays simple; a real BullMQ queue/Redis only exists when
  // the switch is on.
  let producer: PurchaseProducer;
  let worker: PurchaseWorkerHandle | undefined;
  let queueRedis: Redis | undefined;
  let workerRedis: Redis | undefined;
  let queue: ReturnType<typeof createPurchaseQueue> | undefined;

  if (cfg.purchaseMode === 'queue') {
    queueRedis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    workerRedis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
    queue = createPurchaseQueue(queueRedis);
    producer = new BullPurchaseProducer(queue);
    worker = startPurchaseWorker({
      connection: workerRedis,
      saleId: cfg.saleId,
      purchaseService,
      gate: purchaseGate,
    });
  } else {
    producer = {
      async enqueue(): Promise<string> {
        throw new Error('queue mode disabled; set PURCHASE_MODE=queue');
      },
    };
  }

  app.register(servicesPlugin, {
    saleId: cfg.saleId,
    purchaseService,
    saleStatusService,
    purchaseGate,
    purchasesRepo,
    purchaseProducer: producer,
  });

  app.register(healthRoutes);
  app.register(saleStatusRoutes);
  app.register(purchaseRoutes, { purchaseMode: cfg.purchaseMode });
  app.register(purchasesRoutes);

  app.addHook('onClose', async () => {
    await worker?.close();
    await queue?.close();
    await queueRedis?.quit();
    await workerRedis?.quit();
  });

  return { app, pool, redis, worker };
}