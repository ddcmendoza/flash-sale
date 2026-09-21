import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SalesListResponse } from '@flash-sale/shared';

/**
 * GET /api/sales — catalog of all flash sales, for the sale selector.
 */
export async function salesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/sales', async (_request: FastifyRequest, _reply: FastifyReply) => {
    const snapshots = await fastify.salesRepo.findAll();
    const response: SalesListResponse = { sales: snapshots };
    return response;
  });
}