import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SaleStatusResponse } from '@flash-sale/shared';

export async function saleStatusRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/sale/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const status: SaleStatusResponse | null =
      await fastify.saleStatusService.getStatus();
    if (!status) return reply.code(404).send({ error: 'sale not found' });
    return status;
  });
}