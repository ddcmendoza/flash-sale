import { useState } from 'react';
import { Link } from 'react-router';
import type { AdminPurchaseRecord, AdminSaleRecord } from '@flash-sale/shared';
import {
  createAdminSale,
  deleteAdminSale,
  fetchAdminPurchases,
  resetAdminSale,
  updateAdminSale,
} from '../services/adminApi';
import { fromLocalInput, toLocalInput } from '../services/format';
import { useAdminSales } from '../hooks/useAdminSales';
import { useFlashMessage } from '../hooks/useFlashMessage';
import { AdminSaleForm } from '../components/AdminSaleForm';
import type { SaleFormState } from '../components/AdminSaleForm';
import { AdminSalesTable } from '../components/AdminSalesTable';
import { FlashMessage } from '../components/FlashMessage';
import { PurchasesPanel } from '../components/PurchasesPanel';

const EMPTY_FORM: SaleFormState = {
  id: '',
  name: '',
  price: '',
  quantity: '',
  start: '',
  end: '',
};

/** Fresh form defaults: starts 1m ago, ends in 1h — a live sale by default. */
function freshForm(): SaleFormState {
  const end = new Date(Date.now() + 60 * 60_000).toISOString();
  const start = new Date(Date.now() - 60_000).toISOString();
  return { ...EMPTY_FORM, start: toLocalInput(start), end: toLocalInput(end) };
}

/** Management page: sales CRUD, reset/restock, purchase inspection. */
export function AdminPage() {
  const { sales, setSales, loading, error } = useAdminSales();
  const { message, show } = useFlashMessage();
  const [form, setForm] = useState<SaleFormState>(freshForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [purchases, setPurchases] = useState<AdminPurchaseRecord[] | null>(null);
  const [purchasesSaleId, setPurchasesSaleId] = useState<string | null>(null);

  const beginEdit = (sale: AdminSaleRecord): void => {
    setEditingId(sale.id);
    setForm({
      id: sale.id,
      name: sale.name,
      price: (sale.priceCents / 100).toFixed(2),
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
    if (!form.name.trim()) return show('error', 'Name is required.');
    const priceCents = Math.round(Number(form.price) * 100);
    const totalQuantity = Number.parseInt(form.quantity, 10);
    if (!Number.isFinite(priceCents) || priceCents <= 0) {
      return show('error', 'Enter a valid price greater than 0.');
    }
    if (!Number.isInteger(totalQuantity) || totalQuantity <= 0) {
      return show('error', 'Enter a valid quantity greater than 0.');
    }
    if (!form.start || !form.end) return show('error', 'Pick a start and end time.');
    if (fromLocalInput(form.end) <= fromLocalInput(form.start)) {
      return show('error', 'End must be after start.');
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
        show('success', `Updated '${sale.name}'.`);
      } else {
        const { sale } = await createAdminSale({
          name: form.name.trim(),
          priceCents,
          totalQuantity,
          ...windowArgs,
          ...(form.id.trim() ? { id: form.id.trim() } : {}),
        });
        setSales((prev) => [...prev, sale].sort((a, b) => a.startAt.localeCompare(b.startAt)));
        show('success', `Created '${sale.name}'.`);
      }
      cancelEdit();
    } catch (err) {
      show('error', err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const doReset = async (sale: AdminSaleRecord): Promise<void> => {
    if (!window.confirm(`Reset '${sale.name}'? Purchases are wiped and stock is restored.`)) return;
    try {
      const { sale: reset } = await resetAdminSale(sale.id);
      setSales((prev) => prev.map((s) => (s.id === reset.id ? reset : s)));
      show('success', `'${reset.name}' is re-armed (${reset.totalQuantity} in stock).`);
    } catch (err) {
      show('error', err instanceof Error ? err.message : 'reset failed');
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
      show('success', `Deleted '${sale.name}'.`);
    } catch (err) {
      show('error', err instanceof Error ? err.message : 'delete failed');
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
      show('error', err instanceof Error ? err.message : 'failed to load purchases');
    }
  };

  return (
    <main className="shell admin">
      <header>
        <div className="admin-title-row">
          <h1>Flash Drop · Admin</h1>
          <Link className="admin-link" to="/">
            ← demo page
          </Link>
        </div>
        <p className="tagline">
          Management surface for all flash sales. Writes go to Postgres directly and
          are pushed live to any connected SSE client. Demo only — no auth.
        </p>
      </header>

      <FlashMessage message={message ?? (error ? { kind: 'error', text: error } : null)} />

      <AdminSaleForm
        form={form}
        editingId={editingId}
        saving={saving}
        onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        onSubmit={() => void submit()}
        onCancel={cancelEdit}
      />

      <AdminSalesTable
        sales={sales}
        loading={loading}
        purchasesSaleId={purchasesSaleId}
        onEdit={beginEdit}
        onReset={doReset}
        onTogglePurchases={openPurchases}
        onDelete={doDelete}
      />

      {purchasesSaleId && <PurchasesPanel saleId={purchasesSaleId} purchases={purchases} />}
    </main>
  );
}