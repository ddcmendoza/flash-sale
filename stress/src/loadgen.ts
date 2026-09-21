import type { PurchaseResponse } from '@flash-sale/shared';

export interface AttemptResult {
  userId: string;
  httpStatus: number;
  result: PurchaseResponse['result'] | 'error';
  latencyMs: number;
  error?: string;
}

export interface LoadGeneratorOptions {
  baseUrl: string;
  userIds: string[];
  concurrency: number;
  requestTimeoutMs?: number;
}

/**
 * Pull-based concurrency: `concurrency` workers each grab the next attempt
 * from a shared cursor. Total in-flight requests is bounded by `concurrency`
 * regardless of how many attempts there are.
 */
export async function runLoad(opts: LoadGeneratorOptions): Promise<AttemptResult[]> {
  const results: AttemptResult[] = [];
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= opts.userIds.length) return;
      const userId = opts.userIds[i]!;
      const t0 = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${opts.baseUrl}/api/purchase`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId }),
          signal: controller.signal,
        });
        const body = (await res.json()) as PurchaseResponse;
        results.push({
          userId,
          httpStatus: res.status,
          result: body.result ?? 'error',
          latencyMs: performance.now() - t0,
        });
      } catch (err) {
        results.push({
          userId,
          httpStatus: 0,
          result: 'error',
          latencyMs: performance.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  return results;
}