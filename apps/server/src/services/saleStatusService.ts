import type { Redis } from 'ioredis';
import type { SaleStatusResponse, SaleSnapshot, SaleStatus } from '@flash-sale/shared';
import { resolveSaleStatus, remaining } from '@flash-sale/shared';
import type { SalesRepo } from '../repos/sales';

const STATUS_CACHE_TTL_SECONDS = 1;

function statusCacheKey(saleId: string): string {
  return `sale:${saleId}:status`;
}

function purchasedCacheKey(saleId: string, userId: string): string {
  return `sale:${saleId}:purchased:${userId}`;
}

/**
 * Slow lane: sale status is computed from Postgres and cached in Redis for 1s.
 * The cache is advisory — the authoritative window/stock check happens inside
 * the purchase transaction against PG `now()`.
 */
export class SaleStatusService {
  constructor(
    private readonly sales: SalesRepo,
    private readonly redis: Redis,
    private readonly saleId: string,
  ) {}

  async getStatus(): Promise<SaleStatusResponse | null> {
    const cached = await this.readCache();
    if (cached) return cached;

    const sale = await this.sales.findById(this.saleId);
    if (!sale) return null;

    const response = this.render(sale);
    await this.writeCache(response).catch(() => {});
    return response;
  }

  async getStatusDirect(sale: SaleSnapshot, now: Date): Promise<SaleStatusResponse> {
    return this.render(sale, now);
  }

  /** Fast-path read used by the purchase gate. Never authoritative. */
  async peekStatus(): Promise<SaleStatus | null> {
    const cached = await this.readCache();
    return cached ? cached.status : null;
  }

  private render(sale: SaleSnapshot, now: Date = new Date()): SaleStatusResponse {
    return {
      status: resolveSaleStatus(sale, now),
      saleId: sale.id,
      name: sale.name,
      priceCents: sale.priceCents,
      totalQuantity: sale.totalQuantity,
      soldCount: sale.soldCount,
      remaining: remaining(sale.soldCount, sale.totalQuantity),
      startAt: sale.startAt.toISOString(),
      endAt: sale.endAt.toISOString(),
    };
  }

  private async readCache(): Promise<SaleStatusResponse | null> {
    const raw = await this.redis.get(statusCacheKey(this.saleId)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SaleStatusResponse;
    } catch {
      return null;
    }
  }

  private async writeCache(response: SaleStatusResponse): Promise<void> {
    await this.redis.set(
      statusCacheKey(this.saleId),
      JSON.stringify(response),
      'EX',
      STATUS_CACHE_TTL_SECONDS,
    );
  }
}

/** Redis fast-path for purchases: instant 409s for repeat buyers. */
export class PurchaseGate {
  constructor(
    private readonly redis: Redis,
    private readonly status: SaleStatusService,
    private readonly saleId: string,
  ) {}

  /** True => this user has a committed purchase (safe; set post-commit). */
  async alreadyPurchased(userId: string): Promise<boolean> {
    const hit = await this.redis
      .exists(purchasedCacheKey(this.saleId, userId))
      .catch(() => 0);
    return hit === 1;
  }

  /** Mark a just-committed purchase. Best-effort; never gating, never awaited
   * by callers that must respond fast. */
  async markPurchased(userId: string): Promise<void> {
    await this.redis.set(purchasedCacheKey(this.saleId, userId), '1').catch(() => {});
  }

  /** Advisory sale-state pre-check. `null` = unknown, caller should go to PG. */
  async peekSaleStatus(): Promise<SaleStatus | null> {
    return this.status.peekStatus();
  }
}