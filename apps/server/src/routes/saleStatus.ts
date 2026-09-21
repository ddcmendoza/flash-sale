import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SaleStatusResponse } from '@flash-sale/shared';

/**
 * GET /api/sales/:saleId/status
 * GET /api/sale/status                    (legacy alias → default sale)
 */
export async function saleStatusRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/sales/:saleId/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { saleId } = request.params as { saleId: string };
      return sendStatus(fastify, reply, saleId);
    },
  );

  fastify.get('/api/sale/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    return sendStatus(fastify, reply, fastify.defaultSaleId);
  });
}

async function sendStatus(
  fastify: FastifyInstance,
  reply: FastifyReply,
  saleId: string,
): Promise<unknown> {
  const status: SaleStatusResponse | null =
    await fastify.saleStatusService.getStatus(saleId);
  if (!status) return reply.code(404).send({ error: 'sale not found' });
  return status;
}