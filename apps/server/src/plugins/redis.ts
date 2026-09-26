import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import { closeRedis } from '../redis/client';

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
        // Advisory clients reject (not park) when Redis is unreachable, so a
        // failed graceful quit must never block shutdown.
        await closeRedis(opts.redis);
      });
    }
  },
  { name: 'flash-sale-redis' },
);