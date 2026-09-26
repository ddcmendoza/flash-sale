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
 *
 * Jobs carry their saleId, so one worker pool serves every sale.
 */
export function startPurchaseWorker(options: {
  connection: ConnectionOptions;
  purchaseService: PurchaseService;
  gate: PurchaseGate;
  onCommitted: (saleId: string) => void;
}): PurchaseWorkerHandle {
  const worker = new Worker<PurchaseJobData>(
    PURCHASE_QUEUE_NAME,
    async (job) => {
      const outcome = await options.purchaseService.attempt(
        job.data.saleId,
        job.data.userId,
      );
      if (outcome.result === 'purchased') {
        // Mirror sync mode exactly: mark the buyer, then refresh the advisory
        // status snapshot from Postgres.
        //
        // This second half is not cosmetic. In queue mode the route returns 202
        // before it reaches its own publishStatus call, so before this the only
        // writer of the status cache was the SSE broadcaster's 1s reconciler —
        // and that reconciler only ticks for sales with a live subscriber. The
        // result was that whether a queue burst got cheap 410s or enqueued
        // almost every request depended on whether a browser tab happened to be
        // open against that sale: 0.7% accepted with a tab open, 98.4% without.
        // Both modes now populate the cache identically.
        await options.gate.markPurchased(job.data.saleId, job.data.userId).catch(() => {});
        options.onCommitted(job.data.saleId);
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