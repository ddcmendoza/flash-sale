import fp from 'fastify-plugin';
import { SaleStatusService, PurchaseGate } from '../services/saleStatusService';
import { PurchaseService } from '../services/purchaseService';
import type { PurchasesRepo } from '../repos/purchases';
import type { PurchaseProducer } from '../queue/producer';

declare module 'fastify' {
  interface FastifyInstance {
    saleId: string;
    purchaseService: PurchaseService;
    saleStatusService: SaleStatusService;
    purchaseGate: PurchaseGate;
    purchasesRepo: PurchasesRepo;
    purchaseProducer: PurchaseProducer;
  }
}

export interface ServicesDeps {
  saleId: string;
  purchaseService: PurchaseService;
  saleStatusService: SaleStatusService;
  purchaseGate: PurchaseGate;
  purchasesRepo: PurchasesRepo;
  purchaseProducer: PurchaseProducer;
}

export const servicesPlugin = fp(
  async (fastify, opts: ServicesDeps) => {
    fastify.decorate('saleId', opts.saleId);
    fastify.decorate('purchaseService', opts.purchaseService);
    fastify.decorate('saleStatusService', opts.saleStatusService);
    fastify.decorate('purchaseGate', opts.purchaseGate);
    fastify.decorate('purchasesRepo', opts.purchasesRepo);
    fastify.decorate('purchaseProducer', opts.purchaseProducer);
  },
  { name: 'flash-sale-services' },
);