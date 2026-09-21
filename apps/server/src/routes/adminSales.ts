import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AdminPurchasesResponse,
  AdminSaleMutationResponse,
  AdminSaleInput,
  AdminSaleReset,
  AdminSaleUpdate,
  AdminSalesListResponse,
} from '@flash-sale/shared';
import { AdminApiError } from '../services/salesAdminService';

/**
 * Demo admin management surface for flash sales (unauthenticated — demo only).
 *   GET    /api/admin/sales                  list all sales with counters
 *   POST   /api/admin/sales                  create a sale
 *   PATCH  /api/admin/sales/:saleId          update a sale
 *   POST   /api/admin/sales/:saleId/reset    wipe purchases + restock/re-arm
 *   DELETE /api/admin/sales/:saleId          delete a sale (purchases cascade)
 *   GET    /api/admin/sales/:saleId/purchases   purchase rows for a sale
 *
 * Mutations flush the sale's advisory Redis keys and push a fresh snapshot
 * over the SSE bus so connected clients update immediately.
 */
export async function adminSalesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/admin/sales', async (_request, _reply) => {
    const response: AdminSalesListResponse = {
      sales: await fastify.salesAdminService.listSales(),
    };
    return response;
  });

  fastify.post('/api/admin/sales', async (request, reply) => {
    const sale = await fastify.salesAdminService.create(request.body as AdminSaleInput);
    const response: AdminSaleMutationResponse = { sale };
    return reply.code(201).send(response);
  });

  fastify.patch(
    '/api/admin/sales/:saleId',
    async (
      request: FastifyRequest<{ Params: { saleId: string }; Body: AdminSaleUpdate }>,
      reply,
    ) => {
    // Matches Fastify's default 415 on JSON body only if content-type absent;
    // body may be a partial update object.
    const sale = await fastify.salesAdminService.update(
      request.params.saleId,
      request.body as AdminSaleUpdate,
    );
    const response: AdminSaleMutationResponse = { sale };
    return reply.code(200).send(response);
  });

  fastify.post(
    '/api/admin/sales/:saleId/reset',
    async (
      request: FastifyRequest<{ Params: { saleId: string }; Body: AdminSaleReset }>,
      reply,
    ) => {
    const sale = await fastify.salesAdminService.reset(
      request.params.saleId,
      (request.body ?? {}) as AdminSaleReset,
    );
    const response: AdminSaleMutationResponse = { sale };
    return reply.code(200).send(response);
  });

  fastify.delete(
    '/api/admin/sales/:saleId',
    async (
      request: FastifyRequest<{ Params: { saleId: string } }>,
      reply,
    ) => {
    await fastify.salesAdminService.remove(request.params.saleId);
    return reply.code(204).send();
  });

  fastify.get(
    '/api/admin/sales/:saleId/purchases',
    async (
      request: FastifyRequest<{ Params: { saleId: string } }>,
      _reply,
    ) => {
    const purchases = await fastify.salesAdminService.listPurchases(
      request.params.saleId,
    );
    const response: AdminPurchasesResponse = { purchases };
    return response;
  });

  fastify.setErrorHandler((err, _request, reply) => {
    if (err instanceof AdminApiError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    return reply.send(err);
  });
}