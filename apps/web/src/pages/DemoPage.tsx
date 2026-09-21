import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useCountdown } from '../hooks/useCountdown';
import { useLiveSale } from '../hooks/useLiveSale';
import { useSalesCatalog } from '../hooks/useSalesCatalog';
import { SaleCard } from '../components/SaleCard';
import { SaleSelector } from '../components/SaleSelector';

/** Public demo page: pick a sale, buy, watch live counters over SSE. */
export function DemoPage() {
  const { sales, setSales, apiError } = useSalesCatalog();
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const { sale, live } = useLiveSale(selectedSaleId);
  const now = useCountdown();

  // Pick a sale once the catalog arrives: prefer one that is live right now,
  // otherwise the first one in the list.
  useEffect(() => {
    if (selectedSaleId || sales.length === 0) return;
    const ts = Date.now();
    const active =
      sales.find((s) => new Date(s.startAt).getTime() <= ts && ts <= new Date(s.endAt).getTime()) ??
      sales[0];
    setSelectedSaleId(active?.id ?? null);
  }, [sales, selectedSaleId]);

  // Mirror the live frame into the sale list row (soldCount drift).
  useEffect(() => {
    if (!sale) return;
    setSales((prev) =>
      prev.map((s) => (s.id === sale.saleId ? { ...s, soldCount: sale.soldCount } : s)),
    );
  }, [sale, setSales]);

  if (apiError && sales.length === 0) {
    return (
      <main className="shell">
        <p className="connect-error">
          Cannot reach the flash-sale API ({apiError}). Is the server running?
        </p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header>
        <h1>Flash Drop</h1>
        <p className="tagline">Multiple drops. Limited stock each. One per person.</p>
        <Link className="admin-link" to="/admin">
          Admin
        </Link>
      </header>

      {sales.length > 0 && (
        <SaleSelector
          sales={sales}
          selectedSaleId={selectedSaleId}
          onSelect={setSelectedSaleId}
        />
      )}

      <SaleCard
        key={selectedSaleId ?? 'none'}
        saleId={selectedSaleId}
        sale={sale}
        live={live}
        now={now}
      />

      <footer>
        <p>
          Each sale is enforced by a Postgres transaction (unique constraint +
          atomic conditional update) with a Redis fast-path in front; live
          counters arrive over Server-Sent Events.
        </p>
      </footer>
    </main>
  );
}