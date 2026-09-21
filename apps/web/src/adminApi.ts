import type {
  AdminPurchaseRecord,
  AdminSaleInput,
  AdminSaleMutationResponse,
  AdminSaleRecord,
  AdminSaleReset,
  AdminSaleUpdate,
  AdminSalesListResponse,
} from '@flash-sale/shared';

const BASE = '/api/admin';

async function resError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // non-JSON body — fall through to the status code
  }
  return `HTTP ${res.status}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await resError(res));
  return (await res.json()) as T;
}

export async function fetchAdminSales(): Promise<AdminSalesListResponse> {
  return json<AdminSalesListResponse>(await fetch(`${BASE}/sales`));
}

export async function createAdminSale(
  input: AdminSaleInput,
): Promise<AdminSaleMutationResponse> {
  return json<AdminSaleMutationResponse>(
    await fetch(`${BASE}/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateAdminSale(
  saleId: string,
  input: AdminSaleUpdate,
): Promise<AdminSaleMutationResponse> {
  return json<AdminSaleMutationResponse>(
    await fetch(`${BASE}/sales/${encodeURIComponent(saleId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function resetAdminSale(
  saleId: string,
  input: AdminSaleReset = {},
): Promise<AdminSaleMutationResponse> {
  return json<AdminSaleMutationResponse>(
    await fetch(`${BASE}/sales/${encodeURIComponent(saleId)}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteAdminSale(saleId: string): Promise<void> {
  const res = await fetch(`${BASE}/sales/${encodeURIComponent(saleId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await resError(res));
}

export async function fetchAdminPurchases(
  saleId: string,
): Promise<AdminPurchaseRecord[]> {
  const list = await json<{ purchases: AdminPurchaseRecord[] }>(
    await fetch(`${BASE}/sales/${encodeURIComponent(saleId)}/purchases`),
  );
  return list.purchases;
}

export function asAdminPrice(record: AdminSaleRecord): string {
  return (record.priceCents / 100).toFixed(2);
}