import type { Redis } from 'ioredis';
import type { SaleStatusResponse } from '@flash-sale/shared';
import type { SaleStatusService } from './saleStatusService';

const CHANNEL_PREFIX = 'flash-sale:events';
const CHANNEL_PATTERN = `${CHANNEL_PREFIX}:*`;

function channelFor(saleId: string): string {
  return `${CHANNEL_PREFIX}:${saleId}`;
}

/**
 * Fan-out bus for live sale snapshots. Publishers write to a Redis channel per
 * sale; this bus subscribes to all of them on one connection and forwards each
 * message to the in-process listeners registered for that sale. Used by the
 * SSE endpoint, so "live data" is real push, not client polling.
 *
 * Redis is advisory here too: it is the fan-out medium, nothing more. If Redis
 * is unavailable, correctness is unaffected — the per-sale broadcaster merely
 * keeps polling Postgres and the HTTP snapshot/status endpoints still answer.
 */
export class LiveBus {
  private listeners = new Map<string, Set<(status: SaleStatusResponse) => void>>();
  private started = false;

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.sub.on('pmessage', (_pattern, channel, message) => {
      const saleId = channel.slice(CHANNEL_PREFIX.length + 1);
      this.dispatch(saleId, message);
    });
    // Advisory connections run with `enableOfflineQueue: false`, so a psubscribe
    // issued before the socket is ready — a cold start against a Redis that is
    // still booting or is down — rejects instead of queueing. Re-arm on the next
    // 'ready' so the fan-out still comes up once Redis is reachable. Once a
    // subscribe has succeeded, ioredis re-issues it on every reconnect itself
    // (`autoResubscribe`), so this only covers the initial subscribe.
    this.sub.on('ready', () => void this.subscribe());
    await this.subscribe();
  }

  private async subscribe(): Promise<void> {
    try {
      await this.sub.psubscribe(CHANNEL_PATTERN);
    } catch {
      // Redis unavailable: SSE fan-out is down, correctness is not. The next
      // 'ready' re-arms the subscription.
    }
  }

  on(
    saleId: string,
    listener: (status: SaleStatusResponse) => void,
  ): () => void {
    const key = channelFor(saleId);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(key);
    };
  }

  hasListeners(saleId: string): boolean {
    return (this.listeners.get(channelFor(saleId))?.size ?? 0) > 0;
  }

  /** Best-effort: never awaited by the purchase hot path. */
  publish(saleId: string, status: SaleStatusResponse): void {
    void this.pub.publish(channelFor(saleId), JSON.stringify(status)).catch(() => {});
  }

  private dispatch(saleId: string, message: string): void {
    let status: SaleStatusResponse;
    try {
      status = JSON.parse(message) as SaleStatusResponse;
    } catch {
      return; // malformed message from a rogue publisher — ignore
    }
    const set = this.listeners.get(channelFor(saleId));
    if (!set) return;
    for (const listener of set) {
      try {
        listener(status);
      } catch {
        // a wedged listener must not break the fan-out for the rest
      }
    }
  }
}

/**
 * Reconciles live snapshots: for every sale currently being watched (has at
 * least one SSE subscriber), reads Postgres on an interval and publishes a new
 * frame whenever anything changed — a purchase committed elsewhere, the window
 * flipping from upcoming → active, stock hitting zero, etc. The purchase hot
 * path also publishes instantly; this ticker is the safety net that keeps the
 * stream live under every condition without trusting any single event.
 */
export class LiveStatusBroadcaster {
  private watched = new Set<string>();
  private lastFrame = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bus: LiveBus,
    private readonly status: SaleStatusService,
    private readonly intervalMs = 1_000,
  ) {}

  watch(saleId: string): void {
    this.watched.add(saleId);
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  unwatch(saleId: string): void {
    this.watched.delete(saleId);
    if (this.watched.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Fire-and-forget instant push right after a purchase commits. */
  publishStatus(saleId: string): void {
    void this.refresh(saleId);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh(saleId: string): Promise<void> {
    const status = await this.status.getStatusFresh(saleId);
    if (!status) return;
    const frame = JSON.stringify(status);
    if (frame === this.lastFrame.get(saleId)) return;
    this.lastFrame.set(saleId, frame);
    this.bus.publish(saleId, status);
  }

  private async tick(): Promise<void> {
    for (const saleId of [...this.watched]) {
      await this.refresh(saleId);
    }
  }
}