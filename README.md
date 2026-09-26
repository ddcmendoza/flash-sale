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
## AI Usage Disclosure

Built with AI assistance. I designed the architecture and the correctness model
— Postgres as the sole source of truth, the single purchase transaction, the
advisory-Redis boundary, and the sync/queue split — and drove those decisions
explicitly. AI was used for scaffolding, boilerplate, and documentation. The
history is the record — `git log` shows one author, granular commits in
dependency order (`init` → shared → server → web → e2e → stress/bench). The
design rationale in this README is mine and I can defend it line by line.

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

Redis answers exactly one question on the purchase path: *"has this user already
won?"* — `PurchaseGate.alreadyPurchased()` returns an instant `409` for repeat
buyers, and the authoritative duplicate stop is still the `UNIQUE` constraint.

It used to answer a second one. The status snapshot is cached for ~1s, and the
purchase path used to peek at it, which meant a cached `upcoming` / `ended` /
`sold_out` could refuse a purchase Postgres considered legal — for up to a second
after a window opened or stock landed, with nothing committed. That is a bug,
not a trade-off, and it fires at the worst possible moment: the start of a sale,
when everyone is hammering.

So rejections no longer read the cache. `PurchaseGate.checkSaleState()` asks
Postgres, with a plain lock-free `SELECT` that evaluates the window against PG
`now()` and returns the same precedence as `resolveSaleStatus` (`upcoming`, then
`ended`, then `sold_out`). It costs one cheap read to short-circuit doomed
requests, which is what a 1s-stale cache was supposed to save, without the stale
refusals. `open` is only a pre-filter verdict: the conditional `UPDATE` inside
the transaction still decides, so the authoritative path is unchanged.

`SaleStatusService` still caches status in Redis for ~1s, but only to serve
`GET .../status` and the SSE frames — nothing is refused on it.

Two failure modes are covered by tests rather than asserted in prose:

| Failure | Result |
|---|---|
| Redis stopped mid-flood | 250 concurrent purchases on a 200-unit sale: **250/250 complete in ~305ms**, the same `200×201 / 50×410` split as the Redis-up baseline, and Postgres shows `sold_count=200`, 200 rows, 200 distinct users. |
| Redis entry poisoned with a status that is false right now | The purchase goes through anyway (`test/integration/cacheLies.test.ts`). |

Both fast paths are best-effort. A Redis flush costs a few extra round-trips to
Postgres — never correctness.

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
apps/e2e/         Playwright end-to-end suite against the real stack
stress/           Locust load-test harness (locustfile + Postgres verifier) + dockerized bench
```

## Stack

| Layer    | Tech |
| -------- | ---- |
| API      | Fastify 5, typed via shared contracts |
| Data     | Postgres 16 (source of truth), Redis 7 (advisory cache), BullMQ 5 (optional queue) |
| Web      | React 19, Vite 7 |
| Language | TypeScript (strict, `verbatimModuleSyntax`, ESM), runs via `tsx` |
| Tests    | Vitest (unit + integration), Playwright (e2e), Locust load harness |

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

**That window is one hour long, so a demo set up on a lunch break has ended by
the time you come back.** Re-running `npm run db:migrate` fixes it: the seed is
self-healing — any demo sale whose window has already closed is re-armed with a
live window, `sold_count` zeroed and its purchases cleared (a live sale is left
strictly alone, so this is safe to run mid-sale). It also flushes the advisory
Redis keys of anything it re-armed, so a previous run's buyer can't be told
`409 already_purchased` for a row that no longer exists. For a full wipe,
including a sale that is still live, use `db:reset` below.

Stop the containers with `npm run db:down`.

## Reset to a clean state

Every test path below is self-cleaning at the *sale* level (each run re-arms the
sales it targets and tears down the ones it seeds). But if you want the whole
stack back to a pristine, freshly-seeded state — zero purchases, `sold_count`
at 0 for all three demo sales, keys flushed — do:

```bash
npm run db:reset   # wipes Postgres data volume, restarts containers, re-applies schema + seeds
```

That runs `docker compose down -v` (drops the `pgdata` volume), brings the
containers back up, and re-runs `db:migrate`, which applies the schema and seeds
the three demo sales from scratch.

> `npm run db:migrate` alone does **not** reset data: existing purchases and
> `sold_count` are left untouched on a sale whose window is still live (useful
> for bringing the schema forward without losing state), and only a sale whose
> window has already **closed** is re-armed. Reset with `db:reset` when you want
> a clean slate regardless of window state.

To be explicit about what each suite needs and does to get to a clean state:

| What you're running | Command | Clean-state behavior |
| ------------------- | ------- | -------------------- |
| Unit + integration tests | `npm test` | Needs `db:up` + `db:migrate` first. Integration tests seed their own `test-*` sales with known state and delete them on teardown; unit tests are DB-free. |
| Full clean stack + dev servers | `npm run db:reset` then `npm run dev:server` + `npm run dev:web` | All three demo sales active, zero stock sold. |
| Browser e2e suite | `npm run test:e2e` | Runs `db:up` + `db:migrate` itself; `globalSetup` re-arms the demo sales (sold_count → 0, live window) and flushes their Redis keys; each test seeds its own `e2e-*` sale and deletes it after. |
| Locust load test (host server) | `npm run stress -s -- <flags>` | Re-arms every `STRESS_SALES` sale on start (wipes purchases, zeroes `sold_count`, re-seeds stock, sets a live window, flushes the Redis fast-path). |
| Dockerized benchmark | `npm run bench -s -- <flags>` | Same re-arm as Locust; the container is removed when the run ends. |
| Admin page / manual exploration | `npm run db:reset` then dev servers | `#/admin` reset button also wipes a single sale's purchases + restores stock. |

Redis is advisory only, so a running `db:reset`-equivalent flush isn't required
for correctness — the e2e `globalSetup`, the Locust re-arm, and every admin
mutation that touches a sale clear the relevant keys anyway.

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

From a clean state: `npm run db:up && npm run db:migrate` (or just
`npm run db:reset`), then any of the above. Integration tests are
self-cleaning — they create their own `test-*` sales from known state and remove
them on teardown, so the shared dev DB's catalog stays uncluttered.

- **Unit** (`apps/server/test/unit`): sale-window boundaries — active exactly at
  `start_at` and `end_at`, `ended` a millisecond later, `sold_out` wins inside
  the window.
- **Integration** (`apps/server/test/integration`): real Fastify + real
  Postgres/Redis. Race suites assert the invariants under concurrency: 40
  parallel attempts by one user → exactly one win; 100 users vs stock 50 →
  exactly 50 winners; N users vs stock N → everyone wins once and
  `sold_count == distinct purchases` everywhere. The admin suite drives the
  full CRUD/reset/delete surface and verifies catalog cleanup.

## End-to-end tests (Playwright)

```bash
npm run test:e2e              # db up + migrate, then the browser suite
npm run e2e:ui                # watch mode with the Playwright UI
```

`apps/e2e/` is a Playwright suite that drives the **real running stack** — the
Fastify API, the Vite SPA (with `/api` proxied to the API), and straight-to-
Postgres ground truth. No mocks: each test creates its own sale through the
real admin API (`makeSale` fixture) and deletes it afterwards, so the shared
dev DB's catalog stays clean. A `globalSetup` re-arms the three demo sales and
flushes the advisory Redis keys before running — so `npm run test:e2e` never
needs a manual reset, even after a load test has sold stock out.

The three spec files cover the demo page's buy flow and per-user limits
(`src/tests/demo.spec.ts`), the sale-window invariants (upcoming / ended /
sold-out, with the badge flipping live over SSE in `src/tests/window.spec.ts`),
and the `#/admin` CRUD surface (create → edit → reset → purchases → delete,
validation, in `src/tests/admin.spec.ts`).

First run only: `npx playwright install chromium` (in `apps/e2e`), so the
browser binary is downloaded (a Darwin/arm64 build is fetched on Apple Silicon
without extra flags). Run `npm run test:e2e` afterwards; the suite reuses
already-running API/web servers when it finds them.

Neither Postgres nor the web server need a code update for the suite; the only
moving parts are URLs, overridable per run:

```bash
E2E_API_URL=http://localhost:3110 E2E_WEB_URL=http://localhost:5173 npm run test:e2e
```

`E2E_API_URL` also becomes the Vite proxy target, so the web app and the API
always agree on where `/api` lives.

## Load testing (Locust)

```bash
cd stress/locust
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm run stress -s -- -u 2000 --spawn-rate 500 -t 60s --headless
```

(Any recent `python3` works — the venv route is portable; `locust`, `psycopg`
and `redis` all ship macOS/arm64 wheels.)

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

- the run actually applied load — **0 requests is a failure**, not a pass. A run
  that never reached the API (bad host, API down, every spawn failed) cannot
  certify anything, so it is reported as `VERIFY: FAIL` and exits non-zero
- `sold_count == purchase rows` (one committed row per sale)
- `sold_count <= total_quantity` (no oversell — catches `OVERSOLD`)
- `distinct winners == sold_count`, and the count matches the expected winners
  (`min(users, stock)` for unique ids, `min(pool size, stock)` for flood)
- when `STRESS_SSE_WATCHERS > 0`, every watched sale must have delivered at
  least one live SSE frame and every connection must have opened cleanly

The base host defaults to `http://localhost:3000`, so the command above needs no
`-H`. Pass `-H` or set `STRESS_HOST` to point elsewhere; `npm run bench` uses
both to reach the pinned container.

`verify.py` is the same Postgres ground-truth check standalone (multi-sale aware
via `STRESS_SALES`), for post-hoc runs (e.g. in CI after a headless run).
Behavior is tuned via env vars: `STRESS_HOST` (base URL when `-H` is absent),
`STRESS_SALES` (comma-separated sale ids;
`SALE_ID` is the legacy single-sale alias), `STRESS_USER_SCHEME` (`unique`
per-vuser id or `flood` pooled ids), `STRESS_FLOOD_USERS`,
`SALE_TOTAL_QUANTITY` (stock, applied to every sale), `STRESS_WINDOW_MINUTES`
(active window length), `STRESS_SSE_WATCHERS` (how many SSE subscribers to
spawn; they open real streams and are verified on stop), `DATABASE_URL`,
`REDIS_URL`. The old TS `stress/` harness was replaced by this; the Postgres
invariants it enforced live on in the Locust hooks.

`npm run stress` is a thin alias: `cd stress/locust && locust` (pass flags
after `--`).

### Dockerized benchmark (consistent, resource-pinned)

Load-testing a laptop server makes results depend on whatever else is running.
`npm run bench` runs the **same API inside a container pinned to a fixed CPU
share and memory budget** (defaults: **2 CPUs / 256 MiB**), then hits it with
Locust:

```bash
npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless
```

Tunable via env (everything else flows straight to Locust):

| Env | Default | Meaning |
| --- | ------- | ------- |
| `STRESS_MODE` | `sync` | write path: `sync` or `queue` (selects the Dockerfile/image; queue runs an in-process BullMQ worker) |
| `STRESS_CPUS` | `2` | `--cpus` for the server container |
| `STRESS_MEM` | `256m` | `--memory` for the server container |
| `STRESS_PORT` | `3000` | host port the container listens on |
| `STRESS_DATABASE_URL` | `postgres://flash:flash@host.docker.internal:5433/flash_sale` | DB the server container talks to |
| `STRESS_REDIS_URL` | `redis://host.docker.internal:6379` | Redis the server container talks to |
| `STRESS_ADD_HOST` | `auto` | `auto` probes whether `host.docker.internal` resolves natively and only injects `--add-host ...:host-gateway` when it doesn't; `1` forces it, `0` disables it |
| `STRESS_SERVER_ENV` | *(empty)* | extra container env, e.g. `PURCHASE_MODE=queue` |

The image (`stress/docker/Dockerfile` for sync, `Dockerfile.queue` for queue
mode) is built from the repo root, the
container's port is published to the host (Docker Desktop doesn't forward
`--network host` loopback) and it points at the same Postgres/Redis as local
dev via `host.docker.internal` — Docker Desktop (macOS/Windows) resolves that
name natively, so the harness only aliases it to the host gateway on plain
Linux Docker (and the `auto` probe decides, so Apple Silicon / macOS works
unchanged; `--cpus`/`--memory` pinning applies inside the Desktop VM).
`STRESS_PORT` defaults to 3000; if that port is
already taken the harness falls back to the next free one until the real
flash-sale API answers the health probe. The Locust harness's normal re-arm +
Postgres verification apply unchanged. The container is removed after the run.
Example with overrides:

```bash
STRESS_CPUS=4 STRESS_MEM=512m STRESS_PORT=3001 STRESS_SALES=flash-sale-001,flash-sale-002,flash-sale-003 \
  npm run bench -s -- -u 1000 --spawn-rate 10 -t 10m --headless

# queue write path (202 accepted; worker drains through the same transaction)
STRESS_MODE=queue npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless
```

#### Mode comparison (sync vs queue, head-to-head)

Head-to-head runs: three identical **60s bursts, 2,000 vusers spawned
instantly** against each mode on the dockerized bench (2 CPUs / 256 MiB
container), alternating sync → queue, each run re-armed from a clean slate
(method + full command list: `tmp/COMPARE_RUNBOOK.md`). Latency in ms. Two load
shapes: **stock 1,000** (contention is brief — the sale sells out under the
spawn storm, then both modes run on fast-path 409/410) and **stock 10**
(extreme contention — every attempt loses, only 10 rows are ever committed):

| Shape | Metric | sync (×3) | queue (×3) |
| ----- | ------ | --------- | ---------- |
| stock 1,000 | requests | 177,371 · 174,223 · 176,405 | 172,098 · 175,620 · 171,396 |
| | throughput | 2,926 · 2,876 · 2,912 req/s | 2,837 · 2,894 · 2,825 req/s |
| | median | 20 · 20 · 20 | 21 · 21 · 21 |
| | p95 | 92 · 96 · 92 | 93 · 93 · 95 |
| | p99 | 570 · 980 · 970 | 950 · 530 · 560 |
| | wins / accepted | 1,000 · 1,000 · 1,000 | ~54,000 accepted |
| | committed rows | 1,000 · 1,000 · 1,000 | drain → 1,000 (verified post-run) |
| stock 10 | requests | 159,424 · 160,611 · 162,486 | 157,830 · 164,522 · 166,177 |
| | throughput | 2,625 · 2,650 · 2,679 req/s | 2,599 · 2,709 · 2,737 req/s |
| | median | 24 · 24 · 23 | 23 · 22 · 22 |
| | p95 | 110 · 100 · 100 | 110 · 95 · 93 |
| | p99 | 770 · 800 · 770 | 1,300 · 1,200 · 1,200 |
| | wins / accepted | 10 · 10 · 10 | ~160,000 accepted (≈ every request) |
| | committed rows | 10 · 10 · 10 | drain → 10 (verified post-run) |
| both | request failures | 0 · 0 · 0 | 0 · 0 · 0 |
| both | verify | PASS ×3 | PASS ×3 |

Takeaways:

- **Correctness is identical and invariant-safe in both modes and both
  shapes.** Every run committed exactly stock (1,000 or 10 winners), zero
  failed requests, `VERIFY: PASS`. The queue's worker drains to the same
  committed rows a few seconds after the run (verified in Postgres post-run) —
  the handoff changes *when* rows commit, never *how many*.
- **Raw throughput is within noise in both shapes.** stock 1,000: sync ~2,905
  vs queue ~2,852 req/s (~+1.8%). stock 10: ~2,651 vs ~2,682 req/s (queue
  +1.2%). On a shared host each mode's own runs span ~3%, so neither shape shows
  a real throughput winner.
- **stock 1,000: latency is a tie.** Median 20/21 ms, p95 ~93 ms; p99 is noisy
  in both (sync 570–980, queue 530–950) from the instant-spawn storm. The queue's
  enqueue hop is offset by returning before commit.
- **stock 10: the queue moves the cost, it doesn't remove it.** With 10 winners
  and ~160k attempts, the mean/median edge narrows or flips to sync — median
  23-24 ms in both, p95 ~95-110 ms in both, and queue's **p99 is markedly worse**
  (1,200-1,300 vs 770-800 ms). Every loser is enqueued (the producer can't know
  the sale sold out without an authoritative read, and AGENTS.md forbids gating
  the write path on a Redis status read), so ~160k of ~160k requests become
  BullMQ jobs that the worker rejects one-by-one. Offloading the row-lock wait
  from the handler is real, but the enqueue path itself pays for it at p99 when
  effort ≫ stock.
- **Both shapes show a heavy tail (~45–59 s max).** It appears in sync *and*
  queue regardless of stock, so it is the spawn storm / shared-host effect, not
  the write path.
- **`accepted` count ≠ purchases in queue mode.** Accepted tracks "enqueued,"
  which under a stock-10 storm is ~every request, while committed rows stay
  exactly 10. The commit gate is still `UNIQUE(sale_id, user_id)`, so only the
  correct number of distinct winners ever land. This is the expected queue-mode
  signature, not a leak.

**So what is the queue actually for?** At these bench shapes (one pinned
container, Locust measuring client-visible latency, store in shared containers)
queue mode buys **no** latency or throughput win and is slightly worse at p99
under effort ≫ stock. Its real value is operational and only shows at shapes
this bench deliberately excludes: keeping the HTTP plane (health, SSE fan-out,
catalog, admin) responsive while the DB is saturated, bounding *client* latency
at the enqueue hop, and retrying failed transactions off the hot path. If the
goal is "fastest request latency on the dockerized bench," sync wins this
benchmark; if the goal is "client responds fast even when the store is the
bottleneck, accepting eventual commit," queue is the tool — the two modes and
the tradeoff are intentional (see AGENTS.md golden rule).