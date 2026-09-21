import type { FastifyInstance } from 'fastify';
import type { UserPurchaseStatusResponse } from '@flash-sale/shared';

/**
 * GET /api/purchases/:userId
 * Reads Postgres directly (never Redis), so it reflects the authoritative
 * state — including purchases just committed by the queue worker.
 */
export async function purchasesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/purchases/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const user = userId.trim();
    if (user.length === 0) {
      return reply.code(400).send({ error: 'userId is required' });
    }

    const row = await fastify.purchasesRepo.findByUser(fastify.saleId, user);

    const response: UserPurchaseStatusResponse = {
      saleId: fastify.saleId,
      userId: user,
      purchased: row !== null,
      purchaseId: row?.id,
      purchasedAt: row ? row.created_at.toISOString() : undefined,
    };
    return response;
  });
}