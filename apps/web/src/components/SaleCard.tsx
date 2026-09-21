import { useState } from 'react';
import type { PurchaseResponse, SaleStatusResponse, UserPurchaseStatusResponse } from '@flash-sale/shared';
import { attemptPurchase, fetchPurchaseStatus } from '../services/salesApi';
import { formatMoney, formatMs } from '../services/format';
import { useFlashMessage } from '../hooks/useFlashMessage';
import type { LiveState } from '../hooks/useLiveSale';
import { StatusBadge } from './StatusBadge';
import { StockBar } from './StockBar';

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

/**
 * One sale's demo card: purchase form, per-user status check, and the live
 * countdown/stock panel. Self-contained per sale — the parent remounts it
 * (React key) when the selection changes so leftover state never leaks across
 * sales.
 */
export function SaleCard({
  saleId,
  sale,
  live,
  now,
}: {
  saleId: string | null;
  sale: SaleStatusResponse | null;
  live: LiveState;
  now: number;
}) {
  const [userId, setUserId] = useState('');
  const [pending, setPending] = useState(false);
  const { message, show } = useFlashMessage();
  const [myStatus, setMyStatus] = useState<UserPurchaseStatusResponse | null>(null);
  const [checkedUserId, setCheckedUserId] = useState<string | null>(null);

  const buy = async (): Promise<void> => {
    const user = userId.trim();
    if (!user) {
      show('error', 'Please enter a user identifier (any unique string).');
      return;
    }
    if (!saleId) return;
    setPending(true);
    try {
      const { body } = await attemptPurchase(saleId, user);
      show(body.result === 'purchased' ? 'success' : 'info', resultText(body.result));
      setCheckedUserId(user);
      setMyStatus(null);
    } catch (err) {
      show('error', err instanceof Error ? err.message : 'request failed');
    } finally {
      setPending(false);
    }
  };

  const checkStatus = async (): Promise<void> => {
    const user = userId.trim();
    if (!user || !saleId) return;
    try {
      setMyStatus(await fetchPurchaseStatus(saleId, user));
      setCheckedUserId(user);
    } catch (err) {
      show('error', err instanceof Error ? err.message : 'status check failed');
    }
  };

  const status = sale?.status ?? 'upcoming';
  const timeLeft = sale
    ? status === 'upcoming'
      ? sale.startAt
        ? new Date(sale.startAt).getTime() - now
        : 0
      : status === 'active' && sale.endAt
        ? new Date(sale.endAt).getTime() - now
        : 0
    : 0;
  const statusMatches = myStatus && checkedUserId;

  return (
    <section className="card" aria-live="polite">
      <div className="card-head">
        <h2>{sale?.name ?? 'Select a drop…'}</h2>
        <StatusBadge status={status} fallback={sale ? undefined : '…'} />
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

      <StockBar
        sold={sale?.soldCount ?? 0}
        total={sale?.totalQuantity ?? 0}
        remaining={sale?.remaining}
      />

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
            disabled={!saleId}
          />
          <button type="submit" disabled={pending || !saleId}>
            {pending ? 'Buying…' : 'Buy Now'}
          </button>
        </div>
      </form>

      <button
        type="button"
        className="ghost"
        onClick={() => void checkStatus()}
        disabled={!saleId}
      >
        Check my purchase status
      </button>

      {message && <p className={`msg msg-${message.kind}`}>{message.text}</p>}
      {statusMatches && (
        <p className={`msg msg-${myStatus.purchased ? 'success' : 'error'}`}>
          {checkedUserId}:{' '}
          {myStatus.purchased
            ? `secured — confirmed ${myStatus.purchasedAt?.slice(0, 19).replace('T', ' at ')}`
            : 'no purchase found for this user'}
        </p>
      )}
    </section>
  );
}