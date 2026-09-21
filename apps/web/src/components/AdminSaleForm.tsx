export interface SaleFormState {
  id: string;
  name: string;
  price: string;
  quantity: string;
  start: string;
  end: string;
}

export function AdminSaleForm({
  form,
  editingId,
  saving,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: SaleFormState;
  editingId: string | null;
  saving: boolean;
  onChange: (patch: Partial<SaleFormState>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="card admin-form">
      <h2>{editingId ? `Edit: ${editingId}` : 'New flash sale'}</h2>
      <div className="admin-grid">
        <label>
          Sale id
          <input
            value={form.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder={editingId ? undefined : 'flash-sale-… (auto if empty)'}
            disabled={Boolean(editingId)}
          />
        </label>
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Midnight Earbuds"
          />
        </label>
        <label>
          Price (USD)
          <input
            value={form.price}
            onChange={(e) => onChange({ price: e.target.value })}
            placeholder="e.g. 99.00"
            inputMode="decimal"
          />
        </label>
        <label>
          Quantity
          <input
            value={form.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
            placeholder="e.g. 500"
            inputMode="numeric"
          />
        </label>
        <label>
          Starts at
          <input
            type="datetime-local"
            value={form.start}
            onChange={(e) => onChange({ start: e.target.value })}
          />
        </label>
        <label>
          Ends at
          <input
            type="datetime-local"
            value={form.end}
            onChange={(e) => onChange({ end: e.target.value })}
          />
        </label>
      </div>
      <div className="row">
        <button type="button" className="primary" onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create sale'}
        </button>
        {editingId && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}