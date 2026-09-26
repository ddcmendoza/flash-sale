import { Redis, type RedisOptions } from 'ioredis';

/**
 * Client options for every **advisory** Redis connection in this server.
 *
 * The fast paths in front of Postgres are all `.catch()`-guarded, and that
 * guard only fires if a command actually *fails*. ioredis' defaults
 * (`maxRetriesPerRequest: null` + `enableOfflineQueue: true`) mean a command
 * issued while Redis is unreachable is parked in the offline queue and never
 * settles — so with a Redis outage the guarded `await redis.get(...)` in
 * `SaleStatusService` blocks the request forever instead of falling through to
 * Postgres. Measured with the container stopped: 250 concurrent purchases, 0
 * completed, every request hung. That turns "Redis is advisory" into "Redis is
 * a hard dependency with a silent failure mode".
 *
 *   enableOfflineQueue: false  a command issued while the socket is not ready
 *                              is rejected immediately (0ms) rather than parked,
 *                              so the existing `.catch()` guards do their job and
 *                              the hot path degrades to Postgres.
 *   maxRetriesPerRequest: 1    a command that was in flight when the socket
 *                              died is retried once, then fails. Bounded.
 *   commandTimeout              bounds a *hung but connected* Redis too, which
 *                              the offline-queue setting alone cannot catch.
 *
 * With these options a Redis outage costs latency (every fast path misses) and
 * nothing else: Postgres still decides every purchase, and the API is
 * measurably slower but fully available.
 */
export const ADVISORY_COMMAND_TIMEOUT_MS = 50;

export const ADVISORY_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: ADVISORY_COMMAND_TIMEOUT_MS,
};

/**
 * Options for the BullMQ producer/worker connections — deliberately *not* the
 * advisory options above. BullMQ's blocking commands (`BRPOPLPUSH` and friends)
 * would be aborted by `commandTimeout`, and `RedisConnection` **throws** at
 * construction if a handed-in ioredis instance carries a truthy
 * `maxRetriesPerRequest`, so these must stay `null`. That is the contract
 * BullMQ requires, not an oversight.
 *
 * A queue-mode broker outage is a different claim from an advisory fast-path
 * outage: work cannot be *accepted* without Redis. The correctness story is
 * unchanged — nothing is lost, because `PurchaseService.attempt()` is
 * idempotent and BullMQ reclaims stalled jobs after a restart.
 */
export const BULLMQ_REDIS_OPTIONS: RedisOptions = { maxRetriesPerRequest: null };

/**
 * Create an advisory Redis client. Always attaches an `error` listener: ioredis
 * emits `error` on every reconnect attempt during an outage, and an unhandled
 * `error` event on an EventEmitter is a hard crash — so without it an outage
 * takes the process down instead of just the cache. The listener is also what
 * makes the outage visible in the logs instead of silent.
 */
export function createAdvisoryRedis(url: string, label: string): Redis {
  const redis = new Redis(url, ADVISORY_REDIS_OPTIONS);
  attachRedisErrorLogger(redis, label);
  return redis;
}

/**
 * Wait until a client is actually connected before issuing the first command.
 *
 * Fail-fast options cut both ways: `enableOfflineQueue: false` means a command
 * issued before the socket is up *rejects immediately* rather than waiting. In
 * the long-running server that is invisible (commands happen seconds after
 * startup), but a short script that creates a client and immediately calls
 * `keys()` gets an instant rejection — which a `.catch(() => [])` then hides.
 *
 * Resolves as soon as the client is ready, and rejects if it is not within
 * `timeoutMs` so callers can decide what to do.
 */
export async function awaitRedisReady(redis: Redis, timeoutMs = 2_000): Promise<void> {
  if (redis.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const done = (err?: Error): void => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onReady = (): void => done();
    const onError = (err: Error): void => done(err);
    const timer = setTimeout(
      () => done(new Error(`redis not ready after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
    redis.once('ready', onReady);
    redis.once('error', onError);
  });
}

/**
 * Log connection errors, never crash on them. Every advisory call site is
 * `.catch()`-guarded and falls through to Postgres, so these are expected
 * during an outage and survivable.
 *
 * Note for `duplicate()`: ioredis builds the copy with `new Redis({...options})`
 * and does **not** carry listeners over, so a duplicated connection needs its
 * own call to this or it crashes the process on the first outage.
 */
export function attachRedisErrorLogger(redis: Redis, label: string): void {
  redis.on('error', (err: Error) => {
    const reason = err.message.split('\n')[0] ?? 'unknown error';
    console.warn(`[redis:${label}] ${reason}`);
  });
}

/**
 * Close a Redis connection. Advisory clients run with
 * `enableOfflineQueue: false`, so `quit()` *rejects* instead of parking when
 * Redis is unreachable — fall back to a hard disconnect so shutdown can never
 * hang on a dead cache.
 */
export async function closeRedis(redis: Redis): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
