import type {
  PurchaseResponse,
  SaleStatusResponse,
  SalesListResponse,
  UserPurchaseStatusResponse,
} from '@flash-sale/shared';
import { apiUrl, httpJson, jsonRequest } from './http';

/** Catalog of every sale, for the selector. */
export async function fetchSales(): Promise<SalesListResponse> {
  return httpJson<SalesListResponse>(apiUrl('/sales'));
}

/** Status snapshot for one sale (cached server-side ~1s). */
export async function fetchSaleStatus(saleId: string): Promise<SaleStatusResponse> {
  return httpJson<SaleStatusResponse>(
    apiUrl(`/sales/${encodeURIComponent(saleId)}/status`),
  );
}

export interface PurchaseAttempt {
  httpStatus: number;
  body: PurchaseResponse;
}

/**
 * Attempt one purchase. Purchase outcomes are carried as HTTP status codes
 * (201/400/409/410/425/202), so non-2xx here is a *domain* answer, not an
 * error — the caller inspects `httpStatus` and `body.result`.
 */
export async function attemptPurchase(
  saleId: string,
  userId: string,
): Promise<PurchaseAttempt> {
  const res = await fetch(
    apiUrl(`/sales/${encodeURIComponent(saleId)}/purchase`),
    jsonRequest({ userId }),
  );
  const body = (await res.json()) as PurchaseResponse;
  return { httpStatus: res.status, body };
}

/** Reads Postgres directly: did this user win this sale? */
export async function fetchPurchaseStatus(
  saleId: string,
  userId: string,
): Promise<UserPurchaseStatusResponse> {
  return httpJson<UserPurchaseStatusResponse>(
    apiUrl(
      `/sales/${encodeURIComponent(saleId)}/purchases/${encodeURIComponent(userId)}`,
    ),
  );
}

/** Live stream URL for a sale; consumed via EventSource (see services/sse.ts). */
export function saleEventsUrl(saleId: string): string {
  return apiUrl(`/sales/${encodeURIComponent(saleId)}/events`);
}