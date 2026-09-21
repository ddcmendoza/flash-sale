import type { Redis } from 'ioredis';
import type {
  AdminPurchaseRecord,
  AdminSaleInput,
  AdminSaleRecord,
  AdminSaleReset,
  AdminSaleUpdate,
} from '@flash-sale/shared';
import { randomUUID } from 'node:crypto';
import type { SalesRepo, AdminSalePatch } from '../repos/sales';
import type { SaleStatusService } from './saleStatusService';
import type { LiveBus } from './liveStatus';

/** An input/mutation error that maps straight to an HTTP status + message. */
export class AdminApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

const MAX_NAME_LENGTH = 255;

/**
 * Demo management surface for flash sales. Writes go straight to Postgres
 * (the source of truth); after every mutation the sale's advisory Redis keys
 * are flushed and a fresh snapshot is published over the SSE bus so any
 * connected client sees the change immediately. This is not a purchase write
 * path — it never touches PurchaseService or the purchase fast paths.
 */
export class SalesAdminService {
  constructor(
    private readonly sales: SalesRepo,
    private readonly redis: Redis,
    private readonly status: SaleStatusService,
    private readonly bus: LiveBus,
  ) {}

  async listSales(): Promise<AdminSaleRecord[]> {
    return this.sales.findAllAdmin();
  }

  async listPurchases(saleId: string): Promise<AdminPurchaseRecord[]> {
    const sale = await this.sales.findById(saleId);
    if (!sale) throw new AdminApiError(404, 'sale not found');
    return this.sales.findPurchases(saleId);
  }

  async create(input: AdminSaleInput): Promise<AdminSaleRecord> {
    const parsed = parseSaleInput(input);
    const saleId = input.id
      ? validateSaleId(input.id)
      : `flash-sale-${randomUUID().slice(0, 8)}`;

    const sale = await this.sales.insertSale({
      id: saleId,
      name: parsed.name,
      priceCents: parsed.priceCents,
      totalQuantity: parsed.totalQuantity,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
    });
    if (!sale) throw new AdminApiError(409, `a sale with id '${saleId}' already exists`);

    await this.publishStatus(saleId);
    return sale;
  }

  async update(saleId: string, input: AdminSaleUpdate): Promise<AdminSaleRecord> {
    validateSaleId(saleId);
    const patch = parseSaleUpdate(input);

    const current = await this.sales.findById(saleId);
    if (!current) throw new AdminApiError(404, 'sale not found');
    if (
      patch.totalQuantity !== undefined &&
      patch.totalQuantity < current.soldCount
    ) {
      throw new AdminApiError(
        400,
        `totalQuantity cannot drop below the ${current.soldCount} units already sold`,
      );
    }

    const sale = await this.sales.updateSale(saleId, patch);
    if (!sale) throw new AdminApiError(404, 'sale not found');

    await this.flushStatusCache(saleId);
    await this.publishStatus(saleId);
    return sale;
  }

  async reset(saleId: string, input: AdminSaleReset): Promise<AdminSaleRecord> {
    validateSaleId(saleId);
    const sale = await this.sales.findById(saleId);
    if (!sale) throw new AdminApiError(404, 'sale not found');

    const startAt = input.startAt ? parseDate('startAt', input.startAt) : new Date(Date.now() - 60_000);
    const endAt = input.endAt ? parseDate('endAt', input.endAt) : new Date(Date.now() + 60 * 60_000);
    if (endAt <= startAt) throw new AdminApiError(400, 'endAt must be after startAt');

    const reset = await this.sales.resetSale(saleId, startAt, endAt);
    if (!reset) throw new AdminApiError(404, 'sale not found');

    await this.flushSaleKeys(saleId);
    await this.publishStatus(saleId);
    return reset;
  }

  async remove(saleId: string): Promise<void> {
    validateSaleId(saleId);
    const existed = await this.sales.deleteSale(saleId);
    if (!existed) throw new AdminApiError(404, 'sale not found');
    await this.flushSaleKeys(saleId);
  }

  // ---- internals ----

  private async publishStatus(saleId: string): Promise<void> {
    const snapshot = await this.status.getStatusFresh(saleId);
    if (snapshot) this.bus.publish(saleId, snapshot);
  }

  /** Any status fast-path cache must reflect the new sale state. */
  private async flushStatusCache(saleId: string): Promise<void> {
    await this.redis.del(`sale:${saleId}:status`).catch(() => {});
  }

  /** Buying state is gone with the sale; drop every advisory key for it. */
  private async flushSaleKeys(saleId: string): Promise<void> {
    const keys = await this.redis.keys(`sale:${saleId}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await this.redis.del(keys).catch(() => {});
  }
}

function validateSaleId(id: string): string {
  const trimmed = id.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,126}$/.test(trimmed)) {
    throw new AdminApiError(
      400,
      'sale id must be 1-127 chars of letters, digits, dot, dash or underscore',
    );
  }
  return trimmed;
}

function parseSaleInput(input: AdminSaleInput): {
  name: string;
  priceCents: number;
  totalQuantity: number;
  startAt: Date;
  endAt: Date;
} {
  const name = parseName(input.name);
  const priceCents = parsePrice(input.priceCents);
  const totalQuantity = parseQuantity(input.totalQuantity);
  const startAt = parseDate('startAt', input.startAt);
  const endAt = parseDate('endAt', input.endAt);
  if (endAt <= startAt) throw new AdminApiError(400, 'endAt must be after startAt');
  return { name, priceCents, totalQuantity, startAt, endAt };
}

function parseSaleUpdate(input: AdminSaleUpdate): AdminSalePatch {
  const patch: AdminSalePatch = {};
  if (input.name !== undefined) patch.name = parseName(input.name);
  if (input.priceCents !== undefined) patch.priceCents = parsePrice(input.priceCents);
  if (input.totalQuantity !== undefined) patch.totalQuantity = parseQuantity(input.totalQuantity);
  if (input.startAt !== undefined) patch.startAt = parseDate('startAt', input.startAt);
  if (input.endAt !== undefined) patch.endAt = parseDate('endAt', input.endAt);
  if (patch.startAt && patch.endAt && patch.endAt <= patch.startAt) {
    throw new AdminApiError(400, 'endAt must be after startAt');
  }
  return patch;
}

function parseName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new AdminApiError(400, 'name is required and must be a non-empty string');
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new AdminApiError(400, `name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

function parsePrice(priceCents: unknown): number {
  const price = Number(priceCents);
  if (!Number.isInteger(price) || price <= 0) {
    throw new AdminApiError(400, 'priceCents must be a positive integer');
  }
  return price;
}

function parseQuantity(totalQuantity: unknown): number {
  const qty = Number(totalQuantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new AdminApiError(400, 'totalQuantity must be a positive integer');
  }
  return qty;
}

function parseDate(field: string, value: unknown): Date {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new AdminApiError(400, `${field} must be a valid ISO date-time string`);
  }
  return new Date(value);
}