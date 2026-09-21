import type { FastifyInstance } from 'fastify';
import type { PurchaseResponse } from '@flash-sale/shared';
import type { PurchaseOutcome } from '../services/purchaseService';

interface PurchaseBody {
  userId?: unknown;
}

export interface PurchaseRouteOptions {
  purchaseMode: 'sync' | 'queue';
}

/**
 * POST /api/purchase                     (legacy alias → default sale)
 * POST /api/sales/:saleId/purchase       { userId }
 *
 * Fast lane (Redis, advisory only): reject finished/upcoming sales in <1ms and
 * repeat buyers instantly. Slow lane (Postgres, authoritative): one
 * transaction — see PurchaseService. In queue mode the route enqueues and
 * answers 202 instead; the worker runs the same transaction.
 */
export async function purchaseRoutes(
  fastify: FastifyInstance,
  opts: PurchaseRouteOptions,
): Promise<void> {
  fastify.post('/api/sales/:saleId/purchase', async (request, reply) => {
    const { saleId } = request.params as { saleId: string };
    return handlePurchase(fastify, opts.purchaseMode, saleId, request, reply);
  });

  fastify.post('/api/purchase', async (request, reply) => {
    return handlePurchase(fastify, opts.purchaseMode, fastify.defaultSaleId, request, reply);
  });
}

async function handlePurchase(
  fastify: FastifyInstance,
  purchaseMode: 'sync' | 'queue',
  saleId: string,
  request: { body?: unknown },
  reply: {
    code(statusCode: number): {
      send(payload: unknown): unknown;
    };
    send(payload: unknown): unknown;
  },
) {
  const body = request.body as PurchaseBody | null;
  const userId = body?.userId;

  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return reply
      .code(400)
      .send(errorBody('invalid_user', 'userId is required and must be a string'));
  }

  // --- Redis fast-path: instant rejects for repeat buyers ---
  const purchased = await fastify.purchaseGate.alreadyPurchased(saleId, userId);
  if (purchased) {
    return reply
      .code(409)
      .send(errorBody('already_purchased', 'You already purchased this item'));
  }

  // --- Redis fast-path: advisory sale-state pre-check ---
  const status = await fastify.purchaseGate.peekSaleStatus(saleId);
  if (status === 'upcoming') {
    return reply
      .code(425)
      .send(errorBody('upcoming', 'The sale has not started yet'));
  }
  if (status === 'sold_out' || status === 'ended') {
    return reply
      .code(410)
      .send(
        errorBody(status, status === 'sold_out' ? 'Sold out' : 'The sale has ended'),
      );
  }

  if (purchaseMode === 'queue') {
    const attemptId = await fastify.purchaseProducer.enqueue(saleId, userId);
    const accepted: PurchaseResponse = {
      result: 'accepted',
      attemptId,
      message: 'Purchase request accepted; check purchase status shortly',
    };
    return reply.code(202).send(accepted);
  }

  const outcome: PurchaseOutcome = await fastify.purchaseService.attempt(saleId, userId);
  if (outcome.result === 'purchased') {
    // Best-effort fast-path cache; the DB row is what counts.
    await fastify.purchaseGate.markPurchased(saleId, userId).catch(() => {});
    // Push the fresh snapshot over SSE immediately (fire-and-forget).
    fastify.liveStatusBroadcaster.publishStatus(saleId);
  }
  return reply.code(codeFor(outcome)).send(bodyFor(outcome));
}

function errorBody(result: PurchaseResponse['result'], message: string): PurchaseResponse {
  return { result, message };
}

function bodyFor(outcome: PurchaseOutcome): PurchaseResponse {
  switch (outcome.result) {
    case 'purchased':
      return {
        result: 'purchased',
        purchaseId: outcome.purchaseId,
        message: 'Purchase confirmed',
      };
    case 'invalid_user':
      return errorBody('invalid_user', 'userId must be 1-255 characters');
    case 'already_purchased':
      return errorBody('already_purchased', 'You already purchased this item');
    case 'sold_out':
      return errorBody('sold_out', 'Sold out');
    case 'ended':
      return errorBody('ended', 'The sale has ended');
    case 'upcoming':
      return errorBody('upcoming', 'The sale has not started yet');
    case 'not_found':
      return errorBody('not_found', 'Sale not found');
  }
}

function codeFor(outcome: PurchaseOutcome): number {
  switch (outcome.result) {
    case 'purchased':
      return 201;
    case 'invalid_user':
      return 400;
    case 'already_purchased':
      return 409;
    case 'sold_out':
    case 'ended':
      return 410;
    case 'upcoming':
      return 425;
    case 'not_found':
      return 404;
  }
}