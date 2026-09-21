import { useCallback, useEffect, useState } from 'react';
import type {
  PurchaseResponse,
  SaleSnapshot,
  SaleStatusResponse,
  UserPurchaseStatusResponse,
} from '@flash-sale/shared';
import {
  attemptPurchase,
  fetchPurchaseStatus,
  fetchSales,
  saleEventsUrl,
} from './api';
import { AdminPage } from './AdminPage';
import './app.css';

type StatusBadge = 'upcoming' | 'active' | 'sold_out' | 'ended';
type LiveState = 'connecting' | 'live' | 'down';

function statusBadge(status: StatusBadge): string {
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

function resultText(result: PurchaseResponse['result']): string {
  switch (result) {
    case 'purchased':
      return 'You got it! Your purchase is confirmed.';
    case 'already_purchased':
      return 'You already secured one — one item per person.';
    case 'sold_out':
      return 'Sold out. Better luck next drop!';
    case 'ended':
      return 'This sale has ended.';
    case 'upcoming':
      return 'The sale has not started yet.';
    case 'accepted':
      return 'Request accepted — processing. Check your status below.';
    case 'invalid_user':
      return 'Please enter a valid user identifier.';
    case 'not_found':
      return 'Sale not found.';
  }
}

function formatMoney(priceCents: number): string {
  return `$${(priceCents / 100).toFixed(2)}`;
}

function useHashRoute(): string {
  const [route, setRoute] = useState<string>(() => window.location.hash);
  useEffect(() => {
    const onChange = (): void => setRoute(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  const [sales, setSales] = useState<SaleSnapshot[]>([]);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const [sale, setSale] = useState<SaleStatusResponse | null>(null);
  const [live, setLive] = useState<LiveState>('connecting');
  const [apiError, setApiError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<'error' | 'info' | 'success'>('info');
  const [myStatus, setMyStatus] = useState<UserPurchaseStatusResponse | null>(null);
  const [checkedUserId, setCheckedUserId] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [checkedSaleId, setCheckedSaleId] = useState<string | null>(null);

  const route = useHashRoute();

  useEffect(() => {
    void fetchSales()
      .then(({ sales: list }) => {
        setSales(list);
        setApiError(null);
        if (list.length > 0) {
          const active =
            list.find((s) => new Date(s.startAt) <= new Date() && new Date() <= new Date(s.endAt)) ??
            list[0]!;
          setSelectedSaleId((current) => current ?? active.id);
        }
      })
      .catch((err) =>
        setApiError(err instanceof Error ? err.message : 'unable to reach API'),
      );
  }, []);

  // Live data over SSE for the selected sale. The server pushes a snapshot on
  // connection and after every purchase; it also reconciles with Postgres on a
  // ticker, so this stays fresh without any client polling.
  useEffect(() => {
    if (!selectedSaleId) return;
    setLive('connecting');
    const source = new EventSource(saleEventsUrl(selectedSaleId));

    source.addEventListener('status', (event) => {
      const frame = JSON.parse((event as MessageEvent).data) as SaleStatusResponse;
      setSale(frame);
      setLive('live');
      setApiError(null);
    });
    source.onerror = () => {
      setLive('down');
    };
    return () => source.close();
  }, [selectedSaleId]);

  // Local countdown ticker; the live frames carry authoritative time anyway.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Mirror the live frame into the sale list row (soldCount/status drift).
  useEffect(() => {
    if (!sale) return;
    setSales((prev) => prev.map((s) => (s.id === sale.saleId ? { ...s, soldCount: sale.soldCount } : s)));
  }, [sale]);

  const selectSale = useCallback((saleId: string) => {
    setSelectedSaleId(saleId);
    setSale(null);
    setLive('connecting');
    setMyStatus(null);
    setCheckedUserId(null);
    setMessage(null);
  }, []);

  const buy = async () => {
    const user = userId.trim();
    if (!user) {
      setMessage('Please enter a user identifier (any unique string).');
      setMessageKind('error');
      return;
    }
    if (!selectedSaleId) return;
    setPending(true);
    setMessage(null);
    try {
      const { body } = await attemptPurchase(selectedSaleId, user);
      setMessage(resultText(body.result));
      setMessageKind(body.result === 'purchased' ? 'success' : 'info');
      setCheckedUserId(user);
      setCheckedSaleId(selectedSaleId);
      setMyStatus(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'request failed');
      setMessageKind('error');
    } finally {
      setPending(false);
    }
  };

  const checkStatus = async () => {
    const user = userId.trim();
    if (!user || !selectedSaleId) return;
    try {
      const status = await fetchPurchaseStatus(selectedSaleId, user);
      setMyStatus(status);
      setCheckedUserId(user);
      setCheckedSaleId(selectedSaleId);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'status check failed');
      setMessageKind('error');
    }
  };

  if (apiError && sales.length === 0) {
    return (
      <main className="shell">
        <p className="connect-error">
          Cannot reach the flash-sale API ({apiError}). Is the server running?
        </p>
      </main>
    );
  }

  const status = sale?.status ?? 'upcoming';
  const progress = sale ? Math.min(100, (sale.soldCount / sale.totalQuantity) * 100) : 0;
  const timeLeft = sale
    ? status === 'upcoming'
      ? sale.startAt ? new Date(sale.startAt).getTime() - now : 0
      : status === 'active' && sale.endAt
        ? new Date(sale.endAt).getTime() - now
        : 0
    : 0;
  const statusMatches =
    myStatus && checkedUserId && checkedSaleId === selectedSaleId;

  if (route.startsWith('#/admin')) {
    return <AdminPage />;
  }

  return (
    <main className="shell">
      <header>
        <h1>Flash Drop</h1>
        <p className="tagline">Multiple drops. Limited stock each. One per person.</p>
        <a className="admin-link" href="#/admin">
          Admin
        </a>
      </header>

      {sales.length > 0 && (
        <section className="sale-list" aria-label="Flash sales">
          {sales.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sale-chip${s.id === selectedSaleId ? ' sale-chip-active' : ''}`}
              onClick={() => selectSale(s.id)}
            >
              <span>{s.name}</span>
              <span className="sale-chip-stock">
                {s.soldCount}/{s.totalQuantity}
              </span>
            </button>
          ))}
        </section>
      )}

      <section className="card" aria-live="polite">
        <div className="card-head">
          <h2>{sale?.name ?? 'Select a drop…'}</h2>
          <span className={`badge badge-${status}`}>
            {sale ? statusBadge(status) : '…'}
          </span>
        </div>

        <div className="meta">
          <span className="price">{sale ? formatMoney(sale.priceCents) : '—'}</span>
          <span className="conn">
            {live === 'live' ? '● live' : live === 'connecting' ? 'connecting…' : '○ reconnecting'}
          </span>
          <span className="countdown">
            {sale && status === 'upcoming' && timeLeft > 0
              ? `starts in ${formatMs(timeLeft)}`
              : sale && status === 'active' && timeLeft > 0
                ? `ends in ${formatMs(timeLeft)}`
                : sale && status === 'active'
                  ? 'closing…'
                  : '\u00a0'}
          </span>
        </div>

        <div className="stock">
          <div className="stock-row">
            <span>{sale?.soldCount ?? 0} sold</span>
            <span>{sale?.remaining ?? '—'} of {sale?.totalQuantity ?? '—'} left</span>
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void buy();
          }}
        >
          <label htmlFor="user">Your identifier</label>
          <div className="row">
            <input
              id="user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="e.g. alice@example.com"
              maxLength={255}
              disabled={!selectedSaleId}
            />
            <button type="submit" disabled={pending || !selectedSaleId}>
              {pending ? 'Buying…' : 'Buy Now'}
            </button>
          </div>
        </form>

        <button
          type="button"
          className="ghost"
          onClick={() => void checkStatus()}
          disabled={!selectedSaleId}
        >
          Check my purchase status
        </button>

        {message && <p className={`msg msg-${messageKind}`}>{message}</p>}
        {statusMatches && (
          <p className={`msg msg-${myStatus.purchased ? 'success' : 'error'}`}>
            {checkedUserId}: {myStatus.purchased
              ? `secured — confirmed ${myStatus.purchasedAt?.slice(0, 19).replace('T', ' at ')}`
              : 'no purchase found for this user'}
          </p>
        )}
      </section>

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

function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m ${seconds}s`;
}