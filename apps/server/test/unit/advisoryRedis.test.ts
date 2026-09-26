import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  ADVISORY_COMMAND_TIMEOUT_MS,
  ADVISORY_REDIS_OPTIONS,
  attachRedisErrorLogger,
  closeRedis,
  createAdvisoryRedis,
} from '../../src/redis/client';

/**
 * Regression guard for the failure mode that made "Redis is advisory, never
 * gating" false: with ioredis' defaults (`maxRetriesPerRequest: null` +
 * `enableOfflineQueue: true`) a command issued while Redis is unreachable is
 * parked in the offline queue and **never settles**, so the `.catch()` guards in
 * `SaleStatusService` never fire and the purchase path blocks forever. Measured
 * against a stopped container: 250 concurrent purchases, 0 completed.
 *
 * These tests talk to a closed port, so they need no Redis and cannot disturb a
 * running one.
 */

const DEAD_URL = 'redis://127.0.0.1:6399';

describe('advisory redis clients fail fast instead of parking', () => {
  it('rejects a command within the command timeout when redis is unreachable', async () => {
    const redis = new Redis(DEAD_URL, ADVISORY_REDIS_OPTIONS);
    try {
      const startedAt = Date.now();
      await expect(redis.get('anything')).rejects.toThrow();
      const elapsed = Date.now() - startedAt;
      // Not "eventually" — bounded by the same budget as a live-but-hung cache.
      expect(elapsed).toBeLessThan(ADVISORY_COMMAND_TIMEOUT_MS * 4);
    } finally {
      await closeRedis(redis);
    }
  });

  it('rejects instead of parking: the default options would still be pending here', async () => {
    // The control case. This client is built with ioredis' defaults, which is
    // exactly what the advisory client must not use. If ioredis ever changed that
    // behaviour, this test would start failing on the race below and the
    // assertion in the test above would stop meaning anything. The error listener
    // keeps ioredis from also dumping unhandled-error stacks while it retries;
    // the point under test is whether the command settles, not the crash.
    const parked = new Redis(DEAD_URL, { maxRetriesPerRequest: null });
    parked.on('error', () => {});
    const pending = parked.get('anything').then(
      () => 'settled',
      () => 'rejected',
    );

    const stillPending = await Promise.race([
      pending,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('pending'), ADVISORY_COMMAND_TIMEOUT_MS * 6),
      ),
    ]);

    await parked.disconnect();
    expect(stillPending).toBe('pending');

    const advisory = new Redis(DEAD_URL, ADVISORY_REDIS_OPTIONS);
    await expect(advisory.get('anything')).rejects.toThrow();
    await closeRedis(advisory);
  });

  it('logs connection errors instead of throwing them as unhandled events', async () => {
    const redis = new Redis(DEAD_URL, ADVISORY_REDIS_OPTIONS);
    const seen: Error[] = [];
    // An `error` event with no listener is an unhandled EventEmitter event, i.e.
    // a process crash. Attaching a listener is what keeps an outage from
    // becoming an outage-with-a-crash-loop.
    attachRedisErrorLogger(redis, 'test');
    redis.on('error', (err: Error) => seen.push(err));

    await expect(redis.get('anything')).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(seen.length).toBeGreaterThan(0);
    await closeRedis(redis);
  });

  it('closes even when redis is unreachable, so shutdown cannot hang', async () => {
    const redis = createAdvisoryRedis(DEAD_URL, 'test-close');
    const startedAt = Date.now();
    await closeRedis(redis);
    expect(Date.now() - startedAt).toBeLessThan(ADVISORY_COMMAND_TIMEOUT_MS * 8);
  });
});
