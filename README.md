# Flash Sale

A high-throughput **flash sale** demo for multiple concurrent drops with limited
stock each. The system must enforce three invariants per sale even under a
flood of concurrent purchase attempts:

- **No overselling** — stock is finite and never goes negative.
- **One item per user** — a user can never win twice in the same sale.
- **Sale window** — the active start/end period is enforced, including at the
  boundaries.

It uses Postgres as the **sole source of truth**, with a Redis fast-path in
front that is strictly advisory. Live counters reach clients over **Server-Sent
Events**; an optional BullMQ queue decouples request rate from database writes
for scale-out.

---

## Architecture

```mermaid
flowchart LR
    subgraph Client
        WEB[React 19 + Vite SPA :5173<br/>EventSource]
        STRESS[Locust harness]
    end

    subgraph API[Fastify API :3000]
        ROUTER[Routes /api/sales,<br/>/api/sales/:saleId/{status,purchase,<br/>purchases/:userId,events}]

        GATE[PurchaseGate<br/>Redis fast-path<br/>advisory only]
        SVC[PurchaseService.attempt<br/>single PG transaction]
        STATUS[SaleStatusService<br/>1s Redis cache]
        LIVE[LiveBus + broadcaster<br/>Redis pub/sub + PG reconciler]

        MODE{Mode}
        PROD[BullMQ producer]
        WORKER[BullMQ worker<br/>concurrency 16]
    end

    REDIS[(Redis :6379<br/>advisory cache + live fan-out)]
    PG[(Postgres :5433<br/>source of truth)]

    WEB -->|proxy /api| ROUTER
    WEB <-->|SSE GET /api/sales/:saleId/events| LIVE
    STRESS --> ROUTER

    ROUTER --> GATE
    GATE --> REDIS
    ROUTER --> STATUS --> REDIS
    ROUTER --> MODE
    MODE -->|sync| SVC
    MODE -->|queue| PROD --> REDIS --> WORKER
    WORKER --> SVC

    SVC --> PG
    SVC -->|publish fresh frame| LIVE
    STATUS --> PG
    LIVE --> PG
```

The core idea is a **two-speed system**: cheap, imperfect checks up front
(Redis) and one authoritative decision on every purchase (Postgres).

### The purchase transaction

Every purchase write funnels through `PurchaseService.attempt()`
(`apps/server/src/services/purchaseService.ts`): `BEGIN`, then two statements,
then `COMMIT`:

```sql
-- 1. Reserve the user's slot — the UNIQUE(sale_id, user_id) constraint is the
--    hard stop for duplicates. Concurrent INSERTs block on the index, then
--    re-check NOT EXISTS against the committed row and insert nothing.
INSERT INTO purchases (sale_id, user_id)
SELECT $1::text, $2::text
WHERE NOT EXISTS (
  SELECT 1 FROM purchases WHERE sale_id = $1 AND user_id = $2
)
RETURNING id;

-- 2. Atomically claim one unit, only while stock remains AND the window is
--    active (checked against Postgres now(), never the client clock).
--    Concurrent sellers serialize on the row lock; each re-evaluates the
--    predicate against the latest committed row, so at most total_quantity
--    UPDATEs ever match — overselling is impossible.
UPDATE sales
   SET sold_count = sold_count + 1,
       updated_at = now()
 WHERE id = $1
   AND sold_count < total_quantity
   AND start_at <= now()
   AND end_at >= now()
 RETURNING sold_count;
```

If the INSERT returns no row the user already purchased → `409`. If the UPDATE
matches nothing the transaction rolls back and the reason is classified from a
fresh read of the sale row (`upcoming` / `ended` / `sold_out`). The constraint
`CHECK (sold_count <= total_quantity)` in the schema is the last line of
defense.

### Redis is advisory, never gating

- `PurchaseGate.alreadyPurchased()` short-circuits repeat buyers with an instant
  `409` — but the authoritative duplicate stop is the UNIQUE constraint.
- `SaleStatusService` computes status from Postgres and caches it in Redis for
  ~1s; a `sold_out`/`ended`/`upcoming` peek can reject requests in <1ms.
- Both fast paths are best-effort. A Redis flush only costs a few extra
  round-trips to Postgres — never correctness.

### Multi-sale API

Everything is keyed by `saleId` — the services, repos, Redis cache keys, and the
`UNIQUE(sale_id, user_id)` constraint were multi-sale from the schema up. The
namespaced routes are the primary API; the original single-sale paths
(`/api/purchase`, `/api/sale/status`, `/api/purchases/:userId`) remain as
aliases that resolve to the **default sale** (`SALE_ID`, `flash-sale-001`), so
existing clients keep working unchanged. A user who wins sale A is free to win
sale B — "one item per user" is scoped per sale.

### Live data over SSE

`GET /api/sales/:saleId/events` is a Server-Sent Events stream:

- The server immediately sends the current snapshot, then a frame on **every
  change**: a purchase commits (the hot path publishes right after the
  transaction) or the window/stock state shifts.
- A **per-sale reconciler** ticks every 1s and reads Postgres directly,
  publishing whenever anything changed. It is the safety net: even if a publish
  is lost, streams converge. It also makes a sale go `active` on the wire the
  moment `start_at` passes *without* any purchase.
- Redis pub/sub is only the **fan-out transport** (`flash-sale:events:*`), never
  the source of truth — a Redis blip degrades live push, never correctness.
- The web SPA replaces its old 2s poll with one `EventSource` per selected sale
  and shows a live/reconnecting indicator.

### Sync vs queue mode

`PURCHASE_MODE` selects the write path (default `sync`):

- **`sync`** — the route runs the transaction inline and answers `201`.
- **`queue`** — the route performs the cheap fast-path checks, enqueues the
  intent via BullMQ, and answers `202 accepted` immediately. A worker
  (`concurrency: 16`) drains the queue through the *same*
  `PurchaseService.attempt()` transaction. Clients poll
  `GET /api/purchases/:userId`, which reads Postgres directly, so idempotency
  holds across retries. A dedicated producer Redis connection buffers bursts,
  so request rate stops being the bottleneck.

## Repo layout

```
infra/            docker-compose (postgres + redis) and SQL schema
packages/shared/  Pure TS package: sale-window resolver + API contract types
apps/server/      Fastify API (business logic, repository layer, optional BullMQ queue)
apps/web/         React 19 + Vite SPA (sale selector + `#/admin` management page)
stress/           Locust load-test harness (locustfile + Postgres verifier)
```

## Stack

| Layer    | Tech |
| -------- | ---- |
| API      | Fastify 5, typed via shared contracts |
| Data     | Postgres 16 (source of truth), Redis 7 (advisory cache), BullMQ 5 (optional queue) |
| Web      | React 19, Vite 7 |
| Language | TypeScript (strict, `verbatimModuleSyntax`, ESM), runs via `tsx` |
| Tests    | Vitest (unit + integration), Locust load harness |

Money is integer cents (`price_cents`). All purchase writes go through one
transaction; there is no alternate write path.

## Getting started

Prereqs: **Node >= 22** and **Docker** (for local Postgres/Redis). All commands
run at repo root.

```bash
npm install          # install all workspaces
npm run db:up        # start postgres + redis in Docker
npm run db:migrate   # apply schema + seed the sale config
npm run dev:server   # Fastify API on :3000 (tsx watch)
npm run dev:web      # Vite React SPA on :5173 (proxies /api -> :3000)
```

The migrate script seeds **three** demo sales (see [Multi-sale seeding](#multi-sale-seeding)):
`flash-sale-001` defaults to 1,000 units at $199.00 with a window of
`now - 5m` → `now + 60m` so a fresh demo is immediately active. All defaults
live in `apps/server/src/config.ts`.

Stop the containers with `npm run db:down`.

## API

`POST /api/sales/:saleId/purchase` with body `{ "userId": "alice@example.com" }`
(`userId` is any unique 1–255 character string) — or the legacy
`POST /api/purchase`, which targets the default sale. One-per-user is per sale,
so the same user can buy once in every sale.

| HTTP | `result` | Meaning |
| ---- | -------- | ------- |
| 201 | `purchased` | Purchase confirmed; body has `purchaseId` |
| 202 | `accepted` | Queue mode: enqueued; body has `attemptId` |
| 400 | `invalid_user` | `userId` missing / empty / non-string / too long |
| 404 | `not_found` | Sale does not exist |
| 409 | `already_purchased` | This user already won (duplicate) |
| 410 | `sold_out` or `ended` | Stock exhausted or window closed |
| 425 | `upcoming` | Sale has not started yet |

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/sales` | Catalog of all sales (for the SPA selector) |
| GET    | `/api/sales/:saleId/status` | Status, price, stock, window (cached ~1s) |
| GET    | `/api/sales/:saleId/purchases/:userId` | Whether a user purchased this sale (reads Postgres directly) |
| GET    | `/api/sales/:saleId/events` | **SSE** live stream of status snapshots |
| GET    | `/api/sale/status` *(legacy)* | Status of the default sale |
| GET    | `/api/purchases/:userId` *(legacy)* | Status of the default sale for a user |
| GET    | `/healthz` | Liveness probe |

### Admin surface (demo)

An unauthenticated, demo-only management UI and API for running the show — no
load testing, no guarantees, just DB-driven control. It writes directly to
Postgres (never through the purchase service), then flushes the sale's
advisory Redis keys and pushes a fresh snapshot over the SSE bus so any open
client converges immediately.

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/admin/sales` | Every sale with counters: sold, remaining, purchase count, status |
| POST   | `/api/admin/sales` | Create a sale (`id` optional; window must be end > start) |
| PATCH  | `/api/admin/sales/:saleId` | Partial update (name, price, quantity, window) |
| POST   | `/api/admin/sales/:saleId/reset` | Wipe purchases + restore stock (re-arms window) |
| DELETE | `/api/admin/sales/:saleId` | Delete a sale (purchases cascade) |
| GET    | `/api/admin/sales/:saleId/purchases` | Purchase rows for a sale |

The web SPA hosts the matching page at `#/admin` (linked from the demo
header): a create/edit form, a full sales table with per-sale progress,
one-click reset, purchase inspection, and delete with confirmation.

### Multi-sale seeding

`npm run db:migrate` seeds **three** demo sales out of the box —
`flash-sale-001` (the `SALE_*` configured default, $199 watch ×1,000),
`flash-sale-002` (earbuds, $99 ×500), `flash-sale-003` (sneakers, $249 ×250) —
each with a live active window so a fresh demo is immediately running.

## Configuration

Environment variables, read once at startup (`apps/server/src/config.ts`):

| Var | Default |
| --- | ------- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` |
| `DATABASE_URL` | `postgres://flash:flash@localhost:5433/flash_sale` |
| `REDIS_URL` | `redis://localhost:6379` |
| `SALE_ID` | `flash-sale-001` |
| `SALE_NAME` | `Flash Drop — Limited Edition Watch` |
| `SALE_PRICE_CENTS` | `19900` |
| `SALE_TOTAL_QUANTITY` | `1000` |
| `SALE_START_AT` / `SALE_END_AT` | ISO timestamps; fall back to a live window (`-5m` / `+60m`) |
| `PURCHASE_MODE` | `sync` (or `queue`) |

## Testing

```bash
npm test          # unit + integration tests (needs db:up + migrate)
npm run typecheck # tsc --noEmit across all workspaces
npm run lint      # ESLint (flat config)
```

- **Unit** (`apps/server/test/unit`): sale-window boundaries — active exactly at
  `start_at` and `end_at`, `ended` a millisecond later, `sold_out` wins inside
  the window.
- **Integration** (`apps/server/test/integration`): real Fastify + real
  Postgres/Redis. Race suites assert the invariants under concurrency: 40
  parallel attempts by one user → exactly one win; 100 users vs stock 50 →
  exactly 50 winners; N users vs stock N → everyone wins once and
  `sold_count == distinct purchases` everywhere. The admin suite drives the
  full CRUD/reset/delete surface and verifies catalog cleanup.

## Load testing (Locust)

```bash
cd stress/locust
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm run stress -s -- -u 2000 --spawn-rate 500 -t 60s --headless
```

`stress/locust/` is a **Locust**-based load harness. The Locust CLI is the
entire load-shaping surface — *different kinds of load are just flags*:

```bash
# instant burst: 2,000 vusers all spawn immediately, hammer for 60s
.venv/bin/locust -f locustfile.py -H http://localhost:3000 -u 2000 --spawn-rate 2000 -t 60s --headless

# ramp / soak: slow spawn climbs concurrency gradually, then holds it
.venv/bin/locust -f locustfile.py -H http://localhost:3000 -u 1000 --spawn-rate 10 -t 10m --headless

# repeat-buyer flood: 200 vusers share a pool of 50 ids, so the same user
# hammers concurrently (exercises the UNIQUE constraint + Redis 409 path)
STRESS_USER_SCHEME=flood STRESS_FLOOD_USERS=50 \
  .venv/bin/locust -f locustfile.py -H http://localhost:3000 -u 200 --spawn-rate 50 -t 30s --headless

# multi-sale burst: hit several active drops at once; vusers round-robin
# across them and invariants are verified per sale
STRESS_SALES=flash-sale-001,flash-sale-002,flash-sale-003 \
  .venv/bin/locust -f locustfile.py -H http://localhost:3000 -u 600 --spawn-rate 600 -t 60s --headless

# add SSE live-data watchers: background subscribers hold EventSource
# connections and must each receive at least one live frame by run end
STRESS_SALES=flash-sale-001,flash-sale-002,flash-sale-003 STRESS_SSE_WATCHERS=10 \
  .venv/bin/locust -f locustfile.py -H http://localhost:3000 -u 500 --spawn-rate 500 -t 60s --headless

# interactive dashboards: charts, live percentiles, failure explorer
.venv/bin/locust -f locustfile.py -H http://localhost:3000 -u 200 --spawn-rate 50
```

Each run is self-contained: on start every sale in the list is **re-armed**
(purchases wiped, `sold_count` zeroed, stock re-seeded, active window set,
Redis fast-path flushed), so it never depends on a stale seed. On stop it
**verifies the three invariants straight from Postgres** per sale and exits
non-zero on any violation:

- `sold_count == purchase rows` (one committed row per sale)
- `sold_count <= total_quantity` (no oversell — catches `OVERSOLD`)
- `distinct winners == sold_count`, and the count matches the expected winners
  (`min(users, stock)` for unique ids, `min(pool size, stock)` for flood)
- when `STRESS_SSE_WATCHERS > 0`, every watched sale must have delivered at
  least one live SSE frame and every connection must have opened cleanly

`verify.py` is the same Postgres ground-truth check standalone (multi-sale aware
via `STRESS_SALES`), for post-hoc runs (e.g. in CI after a headless run).
Behavior is tuned via env vars: `STRESS_SALES` (comma-separated sale ids;
`SALE_ID` is the legacy single-sale alias), `STRESS_USER_SCHEME` (`unique`
per-vuser id or `flood` pooled ids), `STRESS_FLOOD_USERS`,
`SALE_TOTAL_QUANTITY` (stock, applied to every sale), `STRESS_WINDOW_MINUTES`
(active window length), `STRESS_SSE_WATCHERS` (how many SSE subscribers to
spawn; they open real streams and are verified on stop), `DATABASE_URL`,
`REDIS_URL`. The old TS `stress/` harness was replaced by this; the Postgres
invariants it enforced live on in the Locust hooks.

`npm run stress` is a thin alias: `cd stress/locust && locust` (pass flags
after `--`).