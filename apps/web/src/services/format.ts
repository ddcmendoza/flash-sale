import type { AdminSaleRecord, SaleStatus } from '@flash-sale/shared';

export function formatMoney(priceCents: number): string {
  return `$${(priceCents / 100).toFixed(2)}`;
}

/** Admin table price input format: "199.00" (the `$` is rendered in the cell). */
export function asAdminPrice(sale: AdminSaleRecord): string {
  return (sale.priceCents / 100).toFixed(2);
}

export function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function statusLabel(status: SaleStatus): string {
  switch (status) {
    case 'active':
      return 'live';
    case 'sold_out':
      return 'sold out';
    case 'ended':
      return 'ended';
    case 'upcoming':
      return 'starts soon';
  }
}

/** ISO -> `<input type="datetime-local">` value (local wall-clock). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value -> ISO string for the API. */
export function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}