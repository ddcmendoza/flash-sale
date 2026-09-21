import type { SaleStatus } from './types';

/**
 * Resolve the sale status from immutable inputs. Pure and clock-injectable so
 * boundary behavior is unit-testable: a sale at 13:00:00.000 with start_at
 * 13:00:00.000 is already `active`; one at end_at is still `active`; one
 * instant after end_at is `ended`.
 *
 * `sold_out` wins inside the window: the moment the last unit is gone the
 * status flips even though the window has not closed yet.
 */
export function resolveSaleStatus(
  sale: { startAt: Date; endAt: Date; soldCount: number; totalQuantity: number },
  now: Date,
): SaleStatus {
  if (now < sale.startAt) return 'upcoming';
  if (now > sale.endAt) return 'ended';
  if (sale.soldCount >= sale.totalQuantity) return 'sold_out';
  return 'active';
}

export function remaining(soldCount: number, totalQuantity: number): number {
  const r = totalQuantity - soldCount;
  return r >= 0 ? r : 0;
}