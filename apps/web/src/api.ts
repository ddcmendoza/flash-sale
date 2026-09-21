import type {
  SaleStatusResponse,
  PurchaseResponse,
  UserPurchaseStatusResponse,
} from '@flash-sale/shared';

const BASE = '/api';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchSaleStatus(): Promise<SaleStatusResponse> {
  return json<SaleStatusResponse>(await fetch(`${BASE}/sale/status`));
}

export interface PurchaseAttempt {
  httpStatus: number;
  body: PurchaseResponse;
}

export async function attemptPurchase(userId: string): Promise<PurchaseAttempt> {
  const res = await fetch(`${BASE}/purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const body = (await res.json()) as PurchaseResponse;
  return { httpStatus: res.status, body };
}

export async function fetchPurchaseStatus(
  userId: string,
): Promise<UserPurchaseStatusResponse> {
  return json<UserPurchaseStatusResponse>(
    await fetch(`${BASE}/purchases/${encodeURIComponent(userId)}`),
  );
}