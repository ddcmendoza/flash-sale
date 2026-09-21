import type { AdminPurchaseRecord } from '@flash-sale/shared';

export function PurchasesPanel({
  saleId,
  purchases,
}: {
  saleId: string;
  purchases: AdminPurchaseRecord[] | null;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Purchases · {saleId}</h2>
        <span className="conn">
          {purchases ? `${purchases.length} rows (newest first)` : 'loading…'}
        </span>
      </div>
      {purchases && purchases.length === 0 && (
        <p className="muted">No purchases recorded for this sale.</p>
      )}
      {purchases && purchases.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>User</th>
                <th>Purchased at</th>
              </tr>
            </thead>
            <tbody>
              {[...purchases].reverse().map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td className="mono">{p.userId}</td>
                  <td className="mono">{p.createdAt.replace('T', ' ').slice(0, 19)} UTC</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}