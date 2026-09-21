import type { AdminSaleRecord } from '@flash-sale/shared';
import { StatusBadge } from './StatusBadge';
import { StockBar } from './StockBar';

export function AdminSalesTable({
  sales,
  loading,
  purchasesSaleId,
  onEdit,
  onReset,
  onTogglePurchases,
  onDelete,
}: {
  sales: AdminSaleRecord[];
  loading: boolean;
  purchasesSaleId: string | null;
  onEdit: (sale: AdminSaleRecord) => void;
  onReset: (sale: AdminSaleRecord) => void;
  onTogglePurchases: (sale: AdminSaleRecord) => void;
  onDelete: (sale: AdminSaleRecord) => void;
}) {
  const totalSold = sales.reduce((sum, s) => sum + s.soldCount, 0);
  const totalRemaining = sales.reduce((sum, s) => sum + Math.max(0, s.remaining), 0);

  return (
    <section className="card admin-list">
      <div className="card-head">
        <h2>All sales ({sales.length})</h2>
        <span className="conn">
          {totalSold} sold · {totalRemaining} remaining
        </span>
      </div>

      {loading && <p className="muted">loading…</p>}
      {!loading && sales.length === 0 && (
        <p className="muted">No sales yet — create one above.</p>
      )}

      {sales.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Name</th>
                <th>Price</th>
                <th>Stock</th>
                <th>Window</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => (
                <tr key={sale.id}>
                  <td className="mono" title={sale.id}>
                    {sale.id}
                  </td>
                  <td>{sale.name}</td>
                  <td>${(sale.priceCents / 100).toFixed(2)}</td>
                  <td>
                    <StockBar
                      variant="mini"
                      sold={sale.soldCount}
                      total={sale.totalQuantity}
                    />
                  </td>
                  <td className="mono">
                    <div className="window">
                      {sale.startAt.slice(0, 16).replace('T', ' ')} →{' '}
                      {sale.endAt.slice(0, 16).replace('T', ' ')}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={sale.status} />
                    <span className="muted">{sale.purchaseCount} purchases</span>
                  </td>
                  <td>
                    <div className="row actions">
                      <button type="button" className="ghost" onClick={() => onEdit(sale)}>
                        Edit
                      </button>
                      <button type="button" className="ghost" onClick={() => onReset(sale)}>
                        Reset
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onTogglePurchases(sale)}
                      >
                        {purchasesSaleId === sale.id ? 'Hide' : 'Purchases'}
                      </button>
                      <button type="button" className="danger" onClick={() => onDelete(sale)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}