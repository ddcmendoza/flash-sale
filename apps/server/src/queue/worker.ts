import { Worker, type ConnectionOptions } from 'bullmq';
import type { PurchaseService } from '../services/purchaseService';
import type { PurchaseGate } from '../services/saleStatusService';
import { PURCHASE_QUEUE_NAME, type PurchaseJobData } from './producer';

export interface PurchaseWorkerHandle {
  close(): Promise<void>;
}

/**
 * Scale-out path: when `PURCHASE_MODE=queue` the API enqueues intents and this
 * worker drains them through the *same* authoritative `PurchaseService.attempt()`
 * transaction used in sync mode. In this single-process layout the worker runs
 * inside the API process; in production it scales as its own process(es) —
 * the queue is the buffer, so request rate stops being the bottleneck.
 */
export function startPurchaseWorker(options: {
  connection: ConnectionOptions;
  saleId: string;
  purchaseService: PurchaseService;
  gate: PurchaseGate;
}): PurchaseWorkerHandle {
  const worker = new Worker<PurchaseJobData>(
    PURCHASE_QUEUE_NAME,
    async (job) => {
      if (job.data.saleId !== options.saleId) {
        throw new Error('job saleId does not match this worker');
      }
      const outcome = await options.purchaseService.attempt(job.data.userId);
      if (outcome.result === 'purchased') {
        // Best-effort fast-path cache; the DB row is what matters.
        await options.gate.markPurchased(job.data.userId).catch(() => {});
      }
      return { outcome };
    },
    {
      connection: options.connection,
      concurrency: 16,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] purchase job ${job?.id} failed:`, err);
  });

  return { close: () => worker.close() };
}