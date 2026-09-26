import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

const READINESS_TIMEOUT_MS = 1_000;

interface DependencyReport {
  ok: boolean;
  ms: number;
  error?: string;
}

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Liveness: this process is up and serving HTTP. Deliberately
   * dependency-free — a liveness probe that fails when an *advisory* cache is
   * unreachable would restart a process that is perfectly able to sell, and the
   * bench harness polls this exact body.
   */
  fastify.get('/healthz', async () => ({ status: 'ok' }));

  /**
   * Readiness: the honest dependency report.
   *
   *   200 `ready`     Postgres and the advisory cache are both reachable.
   *   200 `degraded`  The advisory cache is unreachable. Purchases still commit
   *                   from Postgres — this is the state the advisory Redis
   *                   clients are built to survive — so the instance stays in
   *                   rotation and the degradation is visible instead of silent.
   *   503 `not_ready` Postgres is unreachable. Nothing can be decided or
   *                   committed without it, so the instance must leave rotation.
   */
  fastify.get('/readyz', async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      probePostgres(fastify.pg),
      probeRedis(fastify.redis),
    ]);

    const ready = postgres.ok;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? (redis.ok ? 'ready' : 'degraded') : 'not_ready',
      postgres,
      redis,
    });
  });
}

async function probePostgres(pool: Pool): Promise<DependencyReport> {
  return probe(async () => {
    await pool.query('SELECT 1');
  });
}

async function probeRedis(redis: Redis): Promise<DependencyReport> {
  return probe(async () => {
    await redis.ping();
  });
}

/** Time-boxed dependency probe: a black-holed socket must not hang the check. */
async function probe(check: () => Promise<unknown>): Promise<DependencyReport> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe timed out after ${READINESS_TIMEOUT_MS}ms`)),
          READINESS_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
    return { ok: true, ms: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
