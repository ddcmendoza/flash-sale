export type SaleStatus = 'upcoming' | 'active' | 'sold_out' | 'ended';

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