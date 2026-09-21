import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export interface RedisPluginOptions {
  redis: Redis;
  /** Only call redis.quit() on close when buildApp created it itself. */
  closeOnClose?: boolean;
}

export const redisPlugin = fp(
  async (fastify, opts: RedisPluginOptions) => {
    fastify.decorate('redis', opts.redis);
    if (opts.closeOnClose) {
      fastify.addHook('onClose', async () => {
        await opts.redis.quit();
      });
    }
  },
  { name: 'flash-sale-redis' },
);