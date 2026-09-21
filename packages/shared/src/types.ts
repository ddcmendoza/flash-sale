export type SaleStatus = 'upcoming' | 'active' | 'sold_out' | 'ended';

export interface SalesListResponse {
  sales: SaleSnapshot[];
}

export interface SaleSnapshot {
  id: string;
  name: string;
  priceCents: number;
  totalQuantity: number;
  soldCount: number;
  startAt: Date;
  endAt: Date;
}

export interface SaleStatusResponse {
  status: SaleStatus;
  saleId: string;
  name: string;
  priceCents: number;
  totalQuantity: number;
  soldCount: number;
  remaining: number;
  startAt: string;
  endAt: string;
}

export type PurchaseResult =
  | 'purchased'
  | 'already_purchased'
  | 'sold_out'
  | 'ended'
  | 'upcoming'
  | 'invalid_user'
  | 'not_found'
  | 'accepted';

export interface PurchaseResponse {
  result: PurchaseResult;
  purchaseId?: string;
  attemptId?: string;
  message: string;
}

export interface UserPurchaseStatusResponse {
  saleId: string;
  userId: string;
  purchased: boolean;
  purchaseId?: string;
  purchasedAt?: string;
}

// --- Admin API (demo management surface; bypasses the purchase fast paths) ---

export interface AdminSaleRecord {
  id: string;
  name: string;
  priceCents: number;
  totalQuantity: number;
  soldCount: number;
  remaining: number;
  purchaseCount: number;
  status: SaleStatus;
  startAt: string;
  endAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSalesListResponse {
  sales: AdminSaleRecord[];
}

export interface AdminPurchaseRecord {
  id: number;
  saleId: string;
  userId: string;
  createdAt: string;
}

export interface AdminPurchasesResponse {
  purchases: AdminPurchaseRecord[];
}

export interface AdminSaleInput {
  id?: string;
  name: string;
  priceCents: number;
  totalQuantity: number;
  startAt: string;
  endAt: string;
}

export interface AdminSaleUpdate {
  name?: string;
  priceCents?: number;
  totalQuantity?: number;
  startAt?: string;
  endAt?: string;
}

export interface AdminSaleReset {
  /** Optional new window (ISO). Defaults to now-1m / now+60m. */
  startAt?: string;
  endAt?: string;
}

export interface AdminSaleMutationResponse {
  sale: AdminSaleRecord;
}