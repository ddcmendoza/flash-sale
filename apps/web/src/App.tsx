import { useCallback, useEffect, useState } from 'react';
import type {
  PurchaseResponse,
  SaleStatusResponse,
  UserPurchaseStatusResponse,
} from '@flash-sale/shared';
import {
  attemptPurchase,
  fetchPurchaseStatus,
  fetchSaleStatus,
} from './api';
import './app.css';

type StatusBadge = 'upcoming' | 'active' | 'sold_out' | 'ended';

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

export function App() {
  const [sale, setSale] = useState<SaleStatusResponse | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<'error' | 'info' | 'success'>('info');
  const [myStatus, setMyStatus] = useState<UserPurchaseStatusResponse | null>(null);
  const [checkedUserId, setCheckedUserId] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  const poll = useCallback(async () => {
    try {
      const status = await fetchSaleStatus();
      setSale(status);
      setApiError(null);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'unable to reach API');
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => {
      void poll();
      setNow(Date.now());
    }, 2000);
    return () => clearInterval(timer);
  }, [poll]);

  const buy = async () => {
    const user = userId.trim();
    if (!user) {
      setMessage('Please enter a user identifier (any unique string).');
      setMessageKind('error');
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const { body } = await attemptPurchase(user);
      setMessage(resultText(body.result));
      setMessageKind(body.result === 'purchased' ? 'success' : 'info');
      setCheckedUserId(user);
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
    if (!user) return;
    try {
      const status = await fetchPurchaseStatus(user);
      setMyStatus(status);
      setCheckedUserId(user);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'status check failed');
      setMessageKind('error');
    }
  };

  if (apiError && !sale) {
    return (
      <main className="shell">
        <p className="connect-error">Cannot reach the flash-sale API ({apiError}). Is the server running?</p>
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

  return (
    <main className="shell">
      <header>
        <h1>Flash Drop</h1>
        <p className="tagline">One product. Limited stock. One per person.</p>
      </header>

      <section className="card" aria-live="polite">
        <div className="card-head">
          <h2>{sale?.name ?? 'Loading…'}</h2>
          <span className={`badge badge-${status}`}>
            {sale ? statusBadge(status) : '…'}
          </span>
        </div>

        <div className="meta">
          <span className="price">{sale ? formatMoney(sale.priceCents) : '—'}</span>
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
            />
            <button type="submit" disabled={pending}>
              {pending ? 'Buying…' : 'Buy Now'}
            </button>
          </div>
        </form>

        <button type="button" className="ghost" onClick={() => void checkStatus()}>
          Check my purchase status
        </button>

        {message && <p className={`msg msg-${messageKind}`}>{message}</p>}
        {myStatus && checkedUserId && (
          <p className={`msg msg-${myStatus.purchased ? 'success' : 'error'}`}>
            {checkedUserId}: {myStatus.purchased
              ? `secured — confirmed ${myStatus.purchasedAt?.slice(0, 19).replace('T', ' at ')}`
              : 'no purchase found for this user'}
          </p>
        )}
      </section>

      <footer>
        <p>
          Driven by a Postgres transaction (unique constraint + atomic conditional
          update) with a Redis fast-path in front.
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