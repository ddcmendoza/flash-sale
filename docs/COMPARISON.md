# Flash-Sale API Mode Comparison Runbook

Comparative load test of the two API write paths against the dockerized,
resource-pinned bench. This is the method behind the "Mode comparison" table in
the README; it is committed here so the table is reproducible from a fresh
clone, not just from one machine's scratch directory.

| Mode | Dockerfile | Image | Write path |
| ---- | ---------- | ----- | ---------- |
| `sync` | `stress/docker/Dockerfile` | `flash-sale/server:bench` | HTTP handler writes Postgres inline; `201 purchased` on success |
| `queue` | `stress/docker/Dockerfile.queue` | `flash-sale/server:bench-queue` | HTTP handler enqueues to an in-process BullMQ job; `202 accepted`, a worker (concurrency 16) drains through the same `PurchaseService.attempt()` transaction |

Both images run the **same API code** in the same pinned container (2 CPUs /
256 MiB default); only `PURCHASE_MODE` differs. The Locust harness re-arms the
sales on start and verifies the invariants from Postgres on stop in both modes.

## Prereqs

- Node >= 22, Docker, `npm install` done at repo root.
- Postgres + Redis up: `npm run db:up && npm run db:migrate`
- **Do not** run `npm run test:e2e` in parallel — its `globalSetup` re-arms the
  demo sales mid-run and corrupts the verifier's expectations.

## Host the recorded numbers came from

Throughput here is wall-clock throughput of a load generator sharing the host
with Postgres, Redis and the API container, so the host is part of the method.
The numbers in the README were recorded on:

| | |
| --- | --- |
| CPU | AMD Ryzen 7 7700 (8 cores / 16 threads) |
| RAM | 30 GiB |
| OS | Ubuntu 24.04.5 LTS, kernel 7.0.0-34-generic, x86_64 |
| Docker | 29.8.1 |
| Node | v22.23.1 |
| Python (Locust) | 3.12, `stress/locust/requirements.txt` |
| Pinned API container | 2 CPUs / 256 MiB (`STRESS_CPUS=2`, `STRESS_MEM=256m`) |
| Postgres / Redis | unconstrained host containers (this is the caveat: see the note at the end of this file) |

Record your own (`lscpu`, `free -h`, `uname -srm`, `docker --version`,
`node --version`) before comparing against the README table — different hardware
is not a contradiction, it is a different machine.

## Method

Run identical Locust loads against each mode, alternating **sync → queue →
sync → queue**, and compare throughput + latency. Alternating order + re-arm on
start makes each run independent of the previous one's stock (locustfile
re-arms all sales on start regardless of mode).

**Two load shapes matter, and they tell different stories:**

- **High stock (e.g. `SALE_TOTAL_QUANTITY=1000`)** — contention is brief: the
  sale sells out under the spawn storm, then both modes settle onto the
  409/410 fast path. Queue ~ ties sync on latency and throughput here.
- **Effort ≫ stock (e.g. `SALE_TOTAL_QUANTITY=10`)** — every attempt loses and
  only 10 rows ever commit. This is the honest shape for "does the queue
  offload the row-lock wait" question, and the answer on the dockerized bench
  is still a tie: throughput, median, p95 and p99 all overlap. What changes
  is the *enqueue* count, which the route bounds by prechecking the sale in
  Postgres before the enqueue hop (a few dozen to low hundreds of jobs, not
  one per request).

Recorded results (60s, 2,000 vusers spawned instantly, alternating ×3) live in
README.md's "Mode comparison (sync vs queue, head-to-head)" section. If your
numbers disagree with that table, record your host specs and treat the table as
"a different machine" rather than an error — but do investigate a *structural*
difference, e.g. `accepted` landing near your full request count, which means
rejections are being served from a cache (see the SSE-watcher check below).

Create the log directory once before starting, so the `tee`s below do not fail:

```bash
mkdir -p /tmp/flash-sale-bench
```

### Step 1 — Baseline burst (sync first)

```bash
npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless |
  tee /tmp/flash-sale-bench/compare-sync-burst-1.log
```

### Step 2 — Same burst, queue mode

```bash
STRESS_MODE=queue npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless |
  tee /tmp/flash-sale-bench/compare-queue-burst-1.log
```

### Step 3 — Alternate pass (repeat of Step 1)

```bash
npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless |
  tee /tmp/flash-sale-bench/compare-sync-burst-2.log

STRESS_MODE=queue npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless |
  tee /tmp/flash-sale-bench/compare-queue-burst-2.log
```

Run Steps 1–3 **three times** for a meaningful sample (writes depend on PG
warm caches; a single run each is not enough to compare). Keep each run's log:
`/tmp/flash-sale-bench/compare-sync-burst-N.log` and `...-queue-burst-N.log`.

### Effort ≫ stock shape (repeat the alternating ×3 with 10 units)

```bash
# sync
SALE_TOTAL_QUANTITY=10 npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless |
  tee /tmp/flash-sale-bench/compare-sync-stock10-1.log

# queue
SALE_TOTAL_QUANTITY=10 STRESS_MODE=queue npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless |
  tee /tmp/flash-sale-bench/compare-queue-stock10-1.log
```

`SALE_TOTAL_QUANTITY` is threaded through to the Locust re-arm, so both modes
start from the same 10-unit stock each run.

### Optional: ramp/soak (throughput at sustained concurrency)

```bash
# sync
npm run bench -s -- -u 1000 --spawn-rate 10 -t 5m --headless |
  tee /tmp/flash-sale-bench/compare-sync-soak.log

# queue
STRESS_MODE=queue npm run bench -s -- -u 1000 --spawn-rate 10 -t 5m --headless |
  tee /tmp/flash-sale-bench/compare-queue-soak.log
```

### Optional: multi-sale + SSE watchers

```bash
STRESS_SALES=flash-sale-001,flash-sale-002,flash-sale-003 STRESS_SSE_WATCHERS=10 \
  npm run bench -s -- -u 500 --spawn-rate 500 -t 60s --headless

STRESS_SALES=flash-sale-001,flash-sale-002,flash-sale-003 STRESS_SSE_WATCHERS=10 \
  STRESS_MODE=queue npm run bench -s -- -u 500 --spawn-rate 500 -t 60s --headless
```

## What to compare

In each log (`tee`'d) read the Locust aggregate table and the final `VERIFY`
line:

| Metric | `sync` log | `queue` log |
| ------ | ---------- | ----------- |
| req/s (aggregate) | `req/s` column | `req/s` column |
| latency (median / p95 / p99) | percentile table | percentile table |
| request failures | `# fails` column | `# fails` column |
| **wins / accepted** | `VERIFY: PASS … N wins` | `VERIFY: PASS … N accepted` |

Interpretation notes:

- **`VERIFY: PASS` is the product gate in both modes** — all invariants (no
  oversell, `sold_count == purchase rows`, window enforced) must hold under
  load. A `VERIFY: FAIL` or non-zero exit means the mode is **broken under
  load**, not just slower — stop and investigate before comparing throughput.
  A `VERIFY: PASS` that reports **0 requests** is not a pass at all; the harness
  fails the run in that case, so a green line always means load was applied.
- In `sync`, `N wins` should equal `min(vusers, stock)`. In `queue`, `N accepted`
  is the count of `202` responses — a user can collect several 202s before their
  row commits (the producer's duplicate check races the worker's INSERT), so
  `accepted` can exceed the number of distinct purchasers. The committed rows
  still end at `min(vusers, stock)`. Under **effort ≫ stock** this explodes: the
  producer enqueues ~every request (the sale sells out in the first milliseconds,
  and the producer may not know without an authoritative read), so `accepted` ≈
  total requests while committed rows stay at stock — and queue's p99 degrades
  (the enqueue path pays for jobs the worker then rejects). Don't read
  `accepted` as demand or success; read committed rows + failures + the buyer
  fast-paths instead.
- **Queue semantics to read correctly**: `202 accepted` ≠ committed purchase at
  that moment; the worker (16 concurrent, in-process) drains asynchronously.
  Because the worker shares the API container's lifetime, job processing stops
  when `npm run bench` removes the container on exit — whatever is still in the
  handoffs queue is lost. In practice the worker drains in well under a second,
  so on a 60s run every enqueued job commits well before teardown; but on a very
  short burst (`-u`-heavy, tiny `-t`) a late few can be orphaned. Expect
  `sold_count == min(spawned vusers, stock)` once drained. Confirm independently
  after any queue run:

  ```bash
  docker exec flash-sale-postgres psql -U flash -d flash_sale \
    -c "SELECT id, sold_count, total_quantity FROM sales WHERE id='flash-sale-001';"
  ```

  If `sold_count` is below stock, check whether the run simply had fewer vusers
  than stock before suspecting a problem.

## Verifying a run independently (`verify.py`)

The Locust hook already verifies from Postgres, but it runs inside the harness
that produced the load. To check a run from *outside* it — after the fact, in
CI, or against a run whose harness log you do not trust — `verify.py` is the
same ground-truth check standalone:

```bash
cd stress/locust

# after a run against flash-sale-001:
.venv/bin/python verify.py

# same run, multi-sale:
STRESS_SALES=flash-sale-001,flash-sale-002,flash-sale-003 .venv/bin/python verify.py
```

```
Postgres ground truth
------------------------------------------------------------
  flash-sale-001: sold_count=10  purchase rows=10  distinct winners=10  total_quantity=10
RESULT: PASS — invariants held
```

It checks `sold_count == purchase rows`, `sold_count <= total_quantity`, and
`distinct winners == sold_count`, and exits non-zero on any violation.

## Isolating the API (bottleneck attribution)

The bench pins the **API container**, but Locust runs on the host and hits
`localhost:$PORT`. If you want the *server* to be the only bottleneck, use
`--headless` (no UI), keep the host quiet, and use `STRESS_CPUS`/`STRESS_MEM`
to change the API's allocation across modes:

```bash
# queue at the same budget as sync, and at a tighter/looser one:
STRESS_MODE=queue STRESS_CPUS=4 STRESS_MEM=512m \
  npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless
```

Postgres/Redis run in their own containers on the host; they are shared by both
modes, so differences are attributable to the write path, not the store.

## Detecting cache-served rejections (the SSE-watcher signature)

Purchase outcomes must come from Postgres, never from the advisory status
cache. The way that goes wrong is quiet and load-dependent: the SSE
reconciler is the only writer that refreshes the status snapshot when
*nobody is subscribed*, so a cached rejection path makes both the enqueue
rate and the response mix depend on whether a browser happens to have the
stream open.

Cheapest detector: run the same sustained load against two sales, one with a
live SSE subscriber and one without, then compare the enqueue rate.

```bash
# queue mode is where the symptom is most visible (it returns 202 on enqueue)
PURCHASE_MODE=queue npm run dev:server

# in another shell: identical load to both sales, /events open on one only
#   sale A: open `curl -N http://localhost:3000/api/sales/<A>/events`
#   sale B: open nothing
# expect: enqueue rate within a small factor on A and B
```

Measured with 2,000 vusers, 10 units, 8s: **0.2% enqueued on both** (with and
without a subscriber). A build that answered rejections from the cache gave
0.4% with a tab open and 100% without — a 279× swing. Treat any run where
`accepted` approaches the full request count as this bug, not as a queue-mode
characteristic. The same signature shows up in the table above as
`accepted ≈ requests`.

## Cleanup / reset

The bench container is removed automatically at the end of every run (EXIT
trap). After the last comparison run, either leave the stack up for dev or tear
it down:

```bash
npm run db:down        # stop containers (keeps data volume)
npm run db:reset       # full clean slate: wipe volume, restart, re-migrate
```

Neither mode leaves residue behind the other.

## Inputs/env reference (both modes)

| Env | Default | Notes |
| --- | ------- | ----- |
| `STRESS_MODE` | `sync` | `sync` or `queue`; selects Dockerfile + image |
| `STRESS_CPUS` / `STRESS_MEM` | `2` / `256m` | API container resource pin |
| `STRESS_PORT` | `3000` | host port; falls back to next free if taken |
| `STRESS_SALES` | `flash-sale-001` | comma-separated sales to hit & verify |
| `STRESS_SSE_WATCHERS` | `0` | SSE subscribers that must receive a live frame |
| `STRESS_USER_SCHEME` | `unique` | `unique` or `flood` (shared id pool → duplicate storm) |
| `SALE_TOTAL_QUANTITY` | `1000` | stock per sale for re-arm |
| `STRESS_WINDOW_MINUTES` | `60` | active window length after re-arm |
| `STRESS_ADD_HOST` | `auto` | override the `host.docker.internal` probe for the bench container |
| `STRESS_DATABASE_URL` / `STRESS_REDIS_URL` | `host.docker.internal…` | what the API container talks to |

Pass Locust flags after `--` as usual (`-u`, `--spawn-rate`, `-t`, ...).