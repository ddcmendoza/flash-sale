import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SaleStatusResponse } from '@flash-sale/shared';

/**
 * GET /api/sales/:saleId/events — Server-Sent Events stream of live sale
 * snapshots. Sends the current snapshot immediately, then every frame the
 * LiveBus fans out for that sale: pushed instantly after a purchase commits,
 * and reconciled on a 1s ticker straight from Postgres (window flips, sold-out,
 * external writes). Redis is the transport, never the source of truth.
 */
export async function statusEventRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/sales/:saleId/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { saleId } = request.params as { saleId: string };

      // Confirm the sale exists before committing to a stream.
      const initial = await fastify.saleStatusService.getStatus(saleId);
      if (!initial) {
        return reply.code(404).send({ error: 'sale not found' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write('retry: 1000\n\n');

      const send = (status: SaleStatusResponse): void => {
        // Guard against writing after the socket closed/errored.
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        reply.raw.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      };

      send(initial);

      const unsubscribe = fastify.liveBus.on(saleId, send);
      fastify.liveStatusBroadcaster.watch(saleId);

      const cleanup = (): void => {
        unsubscribe();
        fastify.liveStatusBroadcaster.unwatch(saleId);
      };
      request.raw.on('close', cleanup);
      reply.raw.on('close', cleanup);

      // Bare minimum heartbeat so proxies don't reap a quiet-but-alive stream.
      const heartbeat = setInterval(() => {
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        reply.raw.write(': ping\n\n');
      }, 15_000);
      reply.raw.once('close', () => clearInterval(heartbeat));
    },
  );
}