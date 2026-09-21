import type { SaleSnapshot } from '@flash-sale/shared';

export function SaleSelector({
  sales,
  selectedSaleId,
  onSelect,
}: {
  sales: SaleSnapshot[];
  selectedSaleId: string | null;
  onSelect: (saleId: string) => void;
}) {
  return (
    <section className="sale-list" aria-label="Flash sales">
      {sales.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`sale-chip${s.id === selectedSaleId ? ' sale-chip-active' : ''}`}
          onClick={() => onSelect(s.id)}
        >
          <span>{s.name}</span>
          <span className="sale-chip-stock">
            {s.soldCount}/{s.totalQuantity}
          </span>
        </button>
      ))}
    </section>
  );
}