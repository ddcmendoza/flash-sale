import { useCallback, useEffect, useState } from 'react';
import type { AdminPurchaseRecord, AdminSaleRecord } from '@flash-sale/shared';
import {
  asAdminPrice,
  createAdminSale,
  deleteAdminSale,
  fetchAdminPurchases,
  fetchAdminSales,
  resetAdminSale,
  updateAdminSale,
} from './adminApi';

interface SaleForm {
  id: string;
  name: string;
  price: string;
  quantity: string;
  start: string;
  end: string;
}

type Message = { kind: 'error' | 'success'; text: string };

const EMPTY_FORM: SaleForm = {
  id: '',
  name: '',
  price: '',
  quantity: '',
  start: '',
  end: '',
};

/** Fresh form defaults: starts 1m ago, ends in 1h — a live sale by default. */
function freshForm(): SaleForm {
  const end = new Date(Date.now() + 60 * 60_000).toISOString();
  const start = new Date(Date.now() - 60_000).toISOString();
  return { ...EMPTY_FORM, start: toLocalInput(start), end: toLocalInput(end) };
}

/** ISO -> <input type="datetime-local"> value (local wall-clock). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value -> ISO string for the API. */
function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

function statusLabel(status: AdminSaleRecord['status']): string {
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

function progressOf(sale: AdminSaleRecord): number {
  return Math.min(100, (sale.soldCount / sale.totalQuantity) * 100);
}

export function AdminPage() {
  const [sales, setSales] = useState<AdminSaleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<Message | null>(null);
  const [form, setForm] = useState<SaleForm>(freshForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [purchases, setPurchases] = useState<AdminPurchaseRecord[] | null>(null);
  const [purchasesSaleId, setPurchasesSaleId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSales((await fetchAdminSales()).sales);
      setMessage(null);
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'failed to load sales',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showMessage = (kind: Message['kind'], text: string): void =>
    setMessage({ kind, text });

  const beginEdit = (sale: AdminSaleRecord): void => {
    setEditingId(sale.id);
    setForm({
      id: sale.id,
      name: sale.name,
      price: asAdminPrice(sale),
      quantity: String(sale.totalQuantity),
      start: toLocalInput(sale.startAt),
      end: toLocalInput(sale.endAt),
    });
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setForm(freshForm());
  };

  const submit = async (): Promise<void> => {
    if (!form.name.trim()) return showMessage('error', 'Name is required.');
    const priceCents = Math.round(Number(form.price) * 100);
    const totalQuantity = Number.parseInt(form.quantity, 10);
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      return showMessage('error', 'Enter a valid price greater than 0.');
    }
    if (!Number.isInteger(totalQuantity) || totalQuantity <= 0) {
      return showMessage('error', 'Enter a valid quantity greater than 0.');
    }
    if (!form.start || !form.end) return showMessage('error', 'Pick a start and end time.');
    if (fromLocalInput(form.end) <= fromLocalInput(form.start)) {
      return showMessage('error', 'End must be after start.');
    }

    setSaving(true);
    try {
      const windowArgs = {
        startAt: fromLocalInput(form.start),
        endAt: fromLocalInput(form.end),
      };
      if (editingId) {
        const { sale } = await updateAdminSale(editingId, {
          name: form.name.trim(),
          priceCents,
          totalQuantity,
          ...windowArgs,
        });
        setSales((prev) => prev.map((s) => (s.id === sale.id ? sale : s)));
        showMessage('success', `Updated '${sale.name}'.`);
      } else {
        const { sale } = await createAdminSale({
          name: form.name.trim(),
          priceCents,
          totalQuantity,
          ...windowArgs,
          ...(form.id.trim() ? { id: form.id.trim() } : {}),
        });
        setSales((prev) => [...prev, sale].sort((a, b) => a.startAt.localeCompare(b.startAt)));
        showMessage('success', `Created '${sale.name}'.`);
      }
      cancelEdit();
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const doReset = async (sale: AdminSaleRecord): Promise<void> => {
    if (!window.confirm(`Reset '${sale.name}'? Purchases are wiped and stock is restored.`)) return;
    try {
      const { sale: reset } = await resetAdminSale(sale.id);
      setSales((prev) => prev.map((s) => (s.id === reset.id ? reset : s)));
      showMessage('success', `'${reset.name}' is re-armed (${reset.totalQuantity} in stock).`);
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'reset failed');
    }
  };

  const doDelete = async (sale: AdminSaleRecord): Promise<void> => {
    if (!window.confirm(`Delete '${sale.name}' (${sale.id})? This removes its purchases too.`)) return;
    try {
      await deleteAdminSale(sale.id);
      setSales((prev) => prev.filter((s) => s.id !== sale.id));
      if (purchasesSaleId === sale.id) {
        setPurchases(null);
        setPurchasesSaleId(null);
      }
      showMessage('success', `Deleted '${sale.name}'.`);
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'delete failed');
    }
  };

  const openPurchases = async (sale: AdminSaleRecord): Promise<void> => {
    if (purchasesSaleId === sale.id) {
      setPurchases(null);
      setPurchasesSaleId(null);
      return;
    }
    setPurchasesSaleId(sale.id);
    setPurchases([]);
    try {
      setPurchases(await fetchAdminPurchases(sale.id));
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'failed to load purchases');
    }
  };

  const totalRemaining = sales.reduce((sum, s) => sum + Math.max(0, s.remaining), 0);
  const totalSold = sales.reduce((sum, s) => sum + s.soldCount, 0);

  return (
    <main className="shell admin">
      <header>
        <div className="admin-title-row">
          <h1>Flash Drop · Admin</h1>
          <a className="admin-link" href="#/">
            ← demo page
          </a>
        </div>
        <p className="tagline">
          Management surface for all flash sales. Writes go to Postgres directly and
          are pushed live to any connected SSE client. Demo only — no auth.
        </p>
      </header>

      {message && (
        <p className={`msg msg-${message.kind}`} role="status">
          {message.text}
        </p>
      )}

      <section className="card admin-form">
        <h2>{editingId ? `Edit: ${editingId}` : 'New flash sale'}</h2>
        <div className="admin-grid">
          <label>
            Sale id
            <input
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder={editingId ? undefined : 'flash-sale-… (auto if empty)'}
              disabled={Boolean(editingId)}
            />
          </label>
          <label>
            Name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Midnight Earbuds"
            />
          </label>
          <label>
            Price (USD)
            <input
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              placeholder="e.g. 99.00"
              inputMode="decimal"
            />
          </label>
          <label>
            Quantity
            <input
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              placeholder="e.g. 500"
              inputMode="numeric"
            />
          </label>
          <label>
            Starts at
            <input
              type="datetime-local"
              value={form.start}
              onChange={(e) => setForm({ ...form, start: e.target.value })}
            />
          </label>
          <label>
            Ends at
            <input
              type="datetime-local"
              value={form.end}
              onChange={(e) => setForm({ ...form, end: e.target.value })}
            />
          </label>
        </div>
        <div className="row">
          <button type="button" className="primary" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create sale'}
          </button>
          {editingId && (
            <button type="button" className="ghost" onClick={cancelEdit}>
              Cancel
            </button>
          )}
        </div>
      </section>

      <section className="card admin-list">
        <div className="card-head">
          <h2>
            All sales ({sales.length})
          </h2>
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
                    <td>${asAdminPrice(sale)}</td>
                    <td>
                      <div className="stock mini">
                        <span>{sale.soldCount}/{sale.totalQuantity} sold</span>
                        <div className="bar">
                          <div className="bar-fill" style={{ width: `${progressOf(sale)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="mono">
                      <div className="window">
                        {sale.startAt.slice(0, 16).replace('T', ' ')} →{' '}
                        {sale.endAt.slice(0, 16).replace('T', ' ')}
                      </div>
                    </td>
                    <td>
                      <span className={`badge badge-${sale.status}`}>
                        {statusLabel(sale.status)}
                      </span>
                      <span className="muted">{sale.purchaseCount} purchases</span>
                    </td>
                    <td>
                      <div className="row actions">
                        <button type="button" className="ghost" onClick={() => beginEdit(sale)}>
                          Edit
                        </button>
                        <button type="button" className="ghost" onClick={() => void doReset(sale)}>
                          Reset
                        </button>
                        <button type="button" className="ghost" onClick={() => void openPurchases(sale)}>
                          {purchasesSaleId === sale.id ? 'Hide' : 'Purchases'}
                        </button>
                        <button type="button" className="danger" onClick={() => void doDelete(sale)}>
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

      {purchasesSaleId && (
        <section className="card">
          <div className="card-head">
            <h2>Purchases · {purchasesSaleId}</h2>
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
      )}
    </main>
  );
}