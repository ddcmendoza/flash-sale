import type {
  AdminPurchaseRecord,
  AdminSaleInput,
  AdminSaleRecord,
  AdminSaleUpdate,
  PurchaseResponse,
  SaleStatusResponse,
  SalesListResponse,
} from '@flash-sale/shared';
import { env } from './env';

const API = env().apiUrl;

interface ApiResult<T> {
  status: number;
  body: T;
}

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(`${API}${path}`, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 204 No Content and non-JSON bodies are fine for some endpoints
  }
  return { status: res.status, body: body as T };
}

function json(method: 'POST' | 'PATCH', data: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  };
}

export async function adminCreateSale(
  input: AdminSaleInput,
): Promise<AdminSaleRecord> {
  const { status, body } = await call<{ sale: AdminSaleRecord }>(
    '/api/admin/sales',
    json('POST', input),
  );
  if (status !== 201) throw new Error(`admin create failed (HTTP ${status})`);
  return body.sale;
}

export async function adminUpdateSale(
  saleId: string,
  update: AdminSaleUpdate,
): Promise<AdminSaleRecord> {
  const { status, body } = await call<{ sale: AdminSaleRecord }>(
    `/api/admin/sales/${encodeURIComponent(saleId)}`,
    json('PATCH', update),
  );
  if (status !== 200) throw new Error(`admin update failed (HTTP ${status})`);
  return body.sale;
}

export async function adminResetSale(saleId: string): Promise<AdminSaleRecord> {
  const { status, body } = await call<{ sale: AdminSaleRecord }>(
    `/api/admin/sales/${encodeURIComponent(saleId)}/reset`,
    json('POST', {}),
  );
  if (status !== 200) throw new Error(`admin reset failed (HTTP ${status})`);
  return body.sale;
}

export async function adminDeleteSale(saleId: string): Promise<void> {
  const { status } = await call(`/api/admin/sales/${encodeURIComponent(saleId)}`, {
    method: 'DELETE',
  });
  if (status !== 204) throw new Error(`admin delete failed (HTTP ${status})`);
}

export async function adminSalePurchases(
  saleId: string,
): Promise<AdminPurchaseRecord[]> {
  const { status, body } = await call<{ purchases: AdminPurchaseRecord[] }>(
    `/api/admin/sales/${encodeURIComponent(saleId)}/purchases`,
  );
  if (status !== 200) throw new Error(`admin purchases failed (HTTP ${status})`);
  return body.purchases;
}

export async function purchase(
  saleId: string,
  userId: string,
): Promise<ApiResult<PurchaseResponse>> {
  return call<PurchaseResponse>(
    `/api/sales/${encodeURIComponent(saleId)}/purchase`,
    json('POST', { userId }),
  );
}

export async function saleStatus(saleId: string): Promise<SaleStatusResponse> {
  const { status, body } = await call<SaleStatusResponse>(
    `/api/sales/${encodeURIComponent(saleId)}/status`,
  );
  if (status !== 200) throw new Error(`status failed (HTTP ${status})`);
  return body;
}

export async function salesList(): Promise<SalesListResponse> {
  const { status, body } = await call<SalesListResponse>('/api/sales');
  if (status !== 200) throw new Error(`sales list failed (HTTP ${status})`);
  return body;
}