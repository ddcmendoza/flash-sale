import type { Pool } from 'pg';

/**
 * Log errors from the Postgres pool's idle clients, never crash on them.
 *
 * `pg.Pool` emits `error` when an idle client is killed by the server or the
 * network (a Postgres restart, an idle timeout, a dropped connection). An
 * unhandled `error` event on an EventEmitter is a hard process crash, so
 * without this listener a database blip takes the API down even though the
 * pool would have replaced the client and served the next request from a fresh
 * connection. Requests that were actually using the client still reject
 * normally, and the purchase transaction is atomic either way — this is
 * observability plus survival, not a correctness change.
 *
 * Only attach to a pool this process owns: an injected test pool may already be
 * shared, and the listener would outlive the test that installed it.
 */
export function attachPoolErrorLogger(pool: Pool, label: string): void {
  pool.on('error', (err: Error) => {
    const reason = err.message.split('\n')[0] ?? 'unknown error';
    console.warn(`[pg:${label}] ${reason}`);
  });
}
