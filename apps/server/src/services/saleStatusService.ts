import type { Redis } from 'ioredis';
import type {
  SaleSnapshot,
  SaleStatusResponse,
} from '@flash-sale/shared';
import { remaining, resolveSaleStatus } from '@flash-sale/shared';
import type { SaleGateState, SalesRepo } from '../repos/sales';

const STATUS_CACHE_TTL_SECONDS = 1;

/**
 * Lifetime of a `purchased` dedupe marker.
 *
 * The marker is a *fast path*, not a record: `UNIQUE (sale_id, user_id)` is the
 * hard stop for double-wins, so when a marker expires the worst a repeat buyer
 * gets is one extra transaction, which then returns the same 409 from Postgres.
 * That is what makes it safe to bound the marker's life.
 *
 * It has to be bounded. Without a TTL every unique winner leaves a permanent
 * key — a sale with a million winners leaves a million keys, in a system whose
 * entire subject is a flood of unique users, and the only things that ever
 * reclaimed them were an admin reset or a load-test re-arm. Ten minutes is far
 * longer than any realistic repeat-buyer burst (the 30-60s floods in the
 * harness) and far shorter than the lifetime of a sale, so the cache is bounded
 * while the fast path still does its job where it matters.
 */
const PURCHASED_MARKER_TTL_SECONDS = 600;

function statusCacheKey(saleId: string): string {
  return `sale:${saleId}:status`;
}

function purchasedCacheKey(saleId: string, userId: string): string {
  return `sale:${saleId}:purchased:${userId}`;
}

/**
 * Slow lane: sale status is computed from Postgres and cached in Redis for 1s.
 * The cache is advisory — the authoritative window/stock check happens inside
 * the purchase transaction against PG `now()`. All methods take the saleId, so
 * one service instance serves every sale.
 */
export class SaleStatusService {
  constructor(
    private readonly sales: SalesRepo,
    private readonly redis: Redis,
  ) {}

  async getStatus(saleId: string): Promise<SaleStatusResponse | null> {
    const cached = await this.readCache(saleId);
    if (cached) return cached;

    const sale = await this.sales.findById(saleId);
    if (!sale) return null;

    const response = this.render(sale);
    await this.writeCache(saleId, response).catch(() => {});
    return response;
  }

  /** Fresh read straight from Postgres that also refreshes the cache. Used to
   * push an up-to-date snapshot right after a purchase commits. */
  async getStatusFresh(saleId: string): Promise<SaleStatusResponse | null> {
    const sale = await this.sales.findById(saleId);
    if (!sale) return null;
    const response = this.render(sale);
    await this.writeCache(saleId, response).catch(() => {});
    return response;
  }

  getStatusDirect(sale: SaleSnapshot, now: Date): SaleStatusResponse {
    return this.render(sale, now);
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

  private async readCache(saleId: string): Promise<SaleStatusResponse | null> {
    const raw = await this.redis.get(statusCacheKey(saleId)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SaleStatusResponse;
    } catch {
      return null;
    }
  }

  private async writeCache(
    saleId: string,
    response: SaleStatusResponse,
  ): Promise<void> {
    await this.redis.set(
      statusCacheKey(saleId),
      JSON.stringify(response),
      'EX',
      STATUS_CACHE_TTL_SECONDS,
    );
  }
}

/**
 * The gate in front of the purchase path. Two fast paths, in this order:
 *
 *   1. `alreadyPurchased` — Redis dedupe for repeat buyers. This is the one
 *      that pays for itself: it turns the repeat-buyer flood from a pile of
 *      wasted transactions into sub-millisecond 409s. It can only be a false
 *      positive if a purchase row exists, and the flag is set post-commit, so
 *      a 409 here is never wrong.
 *   2. `checkSaleState` — a fresh, lock-free read from Postgres. Deliberately
 *      NOT the 1 s status cache: a cached `upcoming` / `ended` / `sold_out`
 *      refuses buyers the database would admit for up to a second after a
 *      window opens or stock lands, and that refusal is the bug this replaces.
 */
export class PurchaseGate {
  constructor(
    private readonly redis: Redis,
    private readonly sales: SalesRepo,
  ) {}

  /** True => this user has a committed purchase (safe; set post-commit). */
  async alreadyPurchased(saleId: string, userId: string): Promise<boolean> {
    const hit = await this.redis
      .exists(purchasedCacheKey(saleId, userId))
      .catch(() => 0);
    return hit === 1;
  }

  /** Mark a just-committed purchase. Best-effort; never gating, never awaited
   * by callers that must respond fast. Written with an expiry so the dedupe
   * set cannot grow without bound (see PURCHASED_MARKER_TTL_SECONDS). */
  async markPurchased(saleId: string, userId: string): Promise<void> {
    await this.redis
      .set(
        purchasedCacheKey(saleId, userId),
        '1',
        'EX',
        PURCHASED_MARKER_TTL_SECONDS,
      )
      .catch(() => {});
  }

  /**
   * Can this sale be purchased right now? Read fresh from Postgres, evaluated
   * against PG `now()`. `open` is a pre-filter verdict, not a decision: the
   * transaction still decides. Only `not_found`, `upcoming`, `ended` and
   * `sold_out` short-circuit, and each maps to the same HTTP status the
   * transaction would have produced.
   */
  async checkSaleState(saleId: string): Promise<SaleGateState> {
    return this.sales.findGateState(saleId);
  }
}