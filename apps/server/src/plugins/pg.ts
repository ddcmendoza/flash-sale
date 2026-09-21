import fp from 'fastify-plugin';
import type { Pool } from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    pg: Pool;
  }
}

export interface PgPluginOptions {
  pool: Pool;
  /** Only call pool.end() on close when buildApp created the pool itself. */
  closeOnClose?: boolean;
}

export const pgPlugin = fp(
  async (fastify, opts: PgPluginOptions) => {
    fastify.decorate('pg', opts.pool);
    if (opts.closeOnClose) {
      fastify.addHook('onClose', async () => {
        await opts.pool.end();
      });
    }
  },
  { name: 'flash-sale-pg' },
);