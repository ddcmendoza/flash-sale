import type { SaleStatus } from '@flash-sale/shared';
import { statusLabel } from '../services/format';

export function StatusBadge({
  status,
  fallback,
}: {
  status: SaleStatus;
  /** Rendered instead of the label while there is no data (e.g. no sale picked). */
  fallback?: string;
}) {
  return <span className={`badge badge-${status}`}>{fallback ?? statusLabel(status)}</span>;
}