import { Queue, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export const PURCHASE_QUEUE_NAME = 'flash-sale-purchases';

export interface PurchaseJobData {
  saleId: string;
  userId: string;
}

export interface PurchaseProducer {
  enqueue(saleId: string, userId: string): Promise<string>;
}

/**
 * Scale-out path: when `PURCHASE_MODE=queue`, the API performs cheap checks and
 * enqueues here (then answers 202). A worker drains into the authoritative
 * PurchaseService transaction. Clients poll GET /api/purchases/:userId — which
 * reads Postgres — so idempotency holds across retries.
 */
export class BullPurchaseProducer implements PurchaseProducer {
  constructor(private readonly queue: Queue<PurchaseJobData>) {}

  async enqueue(saleId: string, userId: string): Promise<string> {
    const attemptId = crypto.randomUUID();
    await this.queue.add(
      'purchase',
      { saleId, userId },
      {
        jobId: attemptId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 250 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    );
    return attemptId;
  }
}

export function createPurchaseQueue(connection: ConnectionOptions | Redis): Queue<PurchaseJobData> {
  return new Queue<PurchaseJobData>(PURCHASE_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 250 },
    },
  });
}