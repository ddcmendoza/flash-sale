import fp from 'fastify-plugin';
import { SaleStatusService, PurchaseGate } from '../services/saleStatusService';
import { PurchaseService } from '../services/purchaseService';
import { LiveBus, LiveStatusBroadcaster } from '../services/liveStatus';
import { SalesAdminService } from '../services/salesAdminService';
import type { SalesRepo } from '../repos/sales';
import type { PurchasesRepo } from '../repos/purchases';
import type { PurchaseProducer } from '../queue/producer';
import type { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    /** Default sale for the legacy single-sale route aliases. */
    defaultSaleId: string;
    salesRepo: SalesRepo;
    purchaseService: PurchaseService;
    saleStatusService: SaleStatusService;
    purchaseGate: PurchaseGate;
    purchasesRepo: PurchasesRepo;
    purchaseProducer: PurchaseProducer;
    liveBus: LiveBus;
    liveStatusBroadcaster: LiveStatusBroadcaster;
    salesAdminService: SalesAdminService;
  }
}

export interface ServicesDeps {
  defaultSaleId: string;
  salesRepo: SalesRepo;
  purchaseService: PurchaseService;
  saleStatusService: SaleStatusService;
  purchaseGate: PurchaseGate;
  purchasesRepo: PurchasesRepo;
  purchaseProducer: PurchaseProducer;
  liveBus: LiveBus;
  liveStatusBroadcaster: LiveStatusBroadcaster;
  redis: Redis;
}

export const servicesPlugin = fp(
  async (fastify, opts: ServicesDeps) => {
    // Ensure the live fan-out is subscribed before any route can connect, so
    // the first SSE client never misses an early event.
    await opts.liveBus.start();
    const salesAdminService = new SalesAdminService(
      opts.salesRepo,
      opts.redis,
      opts.saleStatusService,
      opts.liveBus,
    );
    fastify.decorate('defaultSaleId', opts.defaultSaleId);
    fastify.decorate('salesRepo', opts.salesRepo);
    fastify.decorate('purchaseService', opts.purchaseService);
    fastify.decorate('saleStatusService', opts.saleStatusService);
    fastify.decorate('purchaseGate', opts.purchaseGate);
    fastify.decorate('purchasesRepo', opts.purchasesRepo);
    fastify.decorate('purchaseProducer', opts.purchaseProducer);
    fastify.decorate('liveBus', opts.liveBus);
    fastify.decorate('liveStatusBroadcaster', opts.liveStatusBroadcaster);
    fastify.decorate('salesAdminService', salesAdminService);
  },
  { name: 'flash-sale-services' },
);