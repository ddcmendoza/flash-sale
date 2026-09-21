import type {
  SaleStatusResponse,
  SalesListResponse,
  PurchaseResponse,
  UserPurchaseStatusResponse,
} from '@flash-sale/shared';

const BASE = '/api';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchSales(): Promise<SalesListResponse> {
  return json<SalesListResponse>(await fetch(`${BASE}/sales`));
}

export async function fetchSaleStatus(saleId: string): Promise<SaleStatusResponse> {
  return json<SaleStatusResponse>(
    await fetch(`${BASE}/sales/${encodeURIComponent(saleId)}/status`),
  );
}

export interface PurchaseAttempt {
  httpStatus: number;
  body: PurchaseResponse;
}

export async function attemptPurchase(
  saleId: string,
  userId: string,
): Promise<PurchaseAttempt> {
  const res = await fetch(`${BASE}/sales/${encodeURIComponent(saleId)}/purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const body = (await res.json()) as PurchaseResponse;
  return { httpStatus: res.status, body };
}

export async function fetchPurchaseStatus(
  saleId: string,
  userId: string,
): Promise<UserPurchaseStatusResponse> {
  return json<UserPurchaseStatusResponse>(
    await fetch(
      `${BASE}/sales/${encodeURIComponent(saleId)}/purchases/${encodeURIComponent(userId)}`,
    ),
  );
}

/** Live stream URL for a sale. The server is SSE, so use EventSource. */
export function saleEventsUrl(saleId: string): string {
  return `${BASE}/sales/${encodeURIComponent(saleId)}/events`;
}