# AGENTS.md

Guidance for AI agents and humans working in this repository.

## What this is

A high-throughput **flash sale** demo for a single product with limited stock.
The system must enforce three invariants even under a flood of concurrent
purchase attempts. See `README.md` for the full architecture story and diagram.

- No overselling: stock is finite and never goes negative.
- One item per user: a user can never win twice.
- Sale window: the active start/end period is enforced, including at the
  boundaries.

## Repo layout

```
infra/            docker-compose (postgres + redis) and SQL schema
packages/shared/  Pure TS package: sale-window resolver + API contract types
apps/server/      Fastify API (business logic, repository layer, optional BullMQ queue)
apps/web/         React 19 + Vite SPA
stress/           Locust load-test harness (locustfile.py + Postgres verifier)
```

## Golden rules (do not violate)

1. **Postgres is the sole source of truth** for stock and purchases.
2. **Redis is advisory only** — a fast-path cache/dedupe. It may lag or be
   flushed without breaking correctness. Never gate the authoritative write on
   a Redis read being "definitely correct".
3. All purchase writes go through `PurchaseService.attempt()` — one PG
   transaction: `INSERT ... WHERE NOT EXISTS` (one-per-user) followed by an
   atomic conditional `UPDATE ... WHERE sold_count < total_quantity AND window
   active`. The `UNIQUE(sale_id, user_id)` constraint is the hard stop for
   duplicates. Do not add an alternate write path.
4. Sale windows are compared against Postgres `now()` inside the atomic UPDATE;
   the client clock is never trusted.

## Commands

Prereqs: Node >= 22, Docker (for local PG/Redis). All commands run at repo root.

```
npm install                # install all workspaces
npm run db:up              # start postgres + redis in Docker
npm run db:migrate         # apply schema + seed the sale config
npm run dev:server         # Fastify API on :3000 (tsx watch)
npm run dev:web            # Vite React SPA on :5173 (proxies /api -> :3000)
npm run test               # unit + integration tests (needs db:up + migrate)
npm run typecheck          # tsc --noEmit across all workspaces
npm run lint               # ESLint (flat config)
npm run stress             # Locust load harness (cd stress/locust && locust); see README.md
npm run db:down            # stop containers
```

## Conventions

- TypeScript, strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
  (use `import type`). `tsc --noEmit` only; runtime is `tsx`/Vite, no build
  step for server code.
- ESM everywhere (`"type": "module"`); use `import ... from '...'` with
  extensions omitted.
- Cross-package imports only via workspace names (`@flash-sale/shared`,
  `@flash-sale/server`, `@flash-sale/web`), always through the public entry
  point (`src/index.ts`), never deep paths.
- Money is integer cents (`price_cents`) to avoid float drift.
- Raw SQL lives in the repository layer (`apps/server/src/repos/`). Services
  orchestrate repositories and transactions. Routes stay thin and map domain
  outcomes to HTTP status codes.
- Fastify plugins go through `fastify-plugin` in `apps/server/src/plugins/`.
- HTTP status semantics for `POST /api/purchase`:
  `201 purchased` / `400 invalid` / `404 not_found` / `409 already_purchased` /
  `410 sold_out | ended` / `425 upcoming` / `202 accepted` (queue mode).
- Env config is read once in `apps/server/src/config.ts`; defaults documented
  there. Never hardcode secrets; dev creds are local-only.

## Testing

- Unit tests (`apps/server/test/unit`): sale-window boundaries, status resolver.
- Integration tests (`apps/server/test/integration`): real Fastify + real
  Postgres/Redis. Race suites assert the invariants (parallel same-user -> one
  win; N users vs M stock -> exactly M winners; sold_count integrity).
- Locust harness (`stress/locust/`) hits the running HTTP server and
  independently verifies the invariants from Postgres (re-arms the sale on
  start, verifies on stop).

## Ports

| Service | Port |
| ------- | ---- |
| Fastify API | 3000 |
| Vite dev server | 5173 |
| Postgres | 5432 |
| Redis | 6379 |