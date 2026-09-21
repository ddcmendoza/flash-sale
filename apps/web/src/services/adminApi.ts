import type {
  AdminPurchaseRecord,
  AdminSaleInput,
  AdminSaleMutationResponse,
  AdminSaleReset,
  AdminSaleUpdate,
  AdminSalesListResponse,
} from '@flash-sale/shared';
import { apiUrl, httpJson, httpStatus, jsonRequest } from './http';

/** Every sale with counters (sold, remaining, purchase count, status). */
export async function fetchAdminSales(): Promise<AdminSalesListResponse> {
  return httpJson<AdminSalesListResponse>(apiUrl('/admin/sales'));
}

export async function createAdminSale(
  input: AdminSaleInput,
): Promise<AdminSaleMutationResponse> {
  return httpJson<AdminSaleMutationResponse>(
    apiUrl('/admin/sales'),
    jsonRequest(input),
  );
}

export async function updateAdminSale(
  saleId: string,
  input: AdminSaleUpdate,
): Promise<AdminSaleMutationResponse> {
  return httpJson<AdminSaleMutationResponse>(apiUrl(`/admin/sales/${encodeURIComponent(saleId)}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function resetAdminSale(
  saleId: string,
  input: AdminSaleReset = {},
): Promise<AdminSaleMutationResponse> {
  return httpJson<AdminSaleMutationResponse>(
    apiUrl(`/admin/sales/${encodeURIComponent(saleId)}/reset`),
    jsonRequest(input),
  );
}

export async function deleteAdminSale(saleId: string): Promise<void> {
  await httpStatus(apiUrl(`/admin/sales/${encodeURIComponent(saleId)}`), {
    method: 'DELETE',
  });
}

export async function fetchAdminPurchases(saleId: string): Promise<AdminPurchaseRecord[]> {
  const list = await httpJson<{ purchases: AdminPurchaseRecord[] }>(
    apiUrl(`/admin/sales/${encodeURIComponent(saleId)}/purchases`),
  );
  return list.purchases;
}