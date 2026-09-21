import type { FastifyInstance } from 'fastify';
import type { UserPurchaseStatusResponse } from '@flash-sale/shared';

/**
 * GET /api/sales/:saleId/purchases/:userId
 * GET /api/purchases/:userId                 (legacy alias → default sale)
 * Reads Postgres directly (never Redis), so it reflects the authoritative
 * state — including purchases just committed by the queue worker.
 */
export async function purchasesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/sales/:saleId/purchases/:userId', async (request, reply) => {
    const { saleId, userId } = request.params as { saleId: string; userId: string };
    return sendPurchaseStatus(fastify, saleId, userId, reply);
  });

  fastify.get('/api/purchases/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    return sendPurchaseStatus(fastify, fastify.defaultSaleId, userId, reply);
  });
}

async function sendPurchaseStatus(
  fastify: FastifyInstance,
  saleId: string,
  rawUserId: string,
  reply: {
    code(statusCode: number): {
      send(payload: unknown): unknown;
    };
    send(payload: unknown): unknown;
  },
): Promise<unknown> {
  const user = rawUserId.trim();
  if (user.length === 0) {
    return reply.code(400).send({ error: 'userId is required' });
  }

  const row = await fastify.purchasesRepo.findByUser(saleId, user);

  const response: UserPurchaseStatusResponse = {
    saleId,
    userId: user,
    purchased: row !== null,
    purchaseId: row?.id,
    purchasedAt: row ? row.created_at.toISOString() : undefined,
  };
  return response;
}