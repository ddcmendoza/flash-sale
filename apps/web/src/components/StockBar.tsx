export type StockBarVariant = 'card' | 'mini';

/** Sold-progress bar; `mini` is the compact form used in admin list rows. */
export function StockBar({
  sold,
  total,
  remaining,
  variant = 'card',
}: {
  sold: number;
  total: number;
  /** Authoritative remaining count from the API frame (falls back to total - sold). */
  remaining?: number;
  variant?: StockBarVariant;
}) {
  const progress = Math.min(100, total > 0 ? (sold / total) * 100 : 0);
  const left = Math.max(0, remaining ?? total - sold);
  if (variant === 'mini') {
    return (
      <div className="stock mini">
        <span>
          {sold}/{total} sold
        </span>
        <div className="bar">
          <div className="bar-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="stock">
      <div className="stock-row">
        <span>{sold} sold</span>
        <span>
          {left} of {total} left
        </span>
      </div>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}