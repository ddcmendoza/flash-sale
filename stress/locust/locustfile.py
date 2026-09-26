"""
Locust load-test for the multi-sale flash-sale API.

The Locust CLI is the entire load-shaping surface — different kinds of load are
just flags:

    # instant burst: 2,000 users all spawn as fast as possible, run 60s
    locust -f locustfile.py -H http://localhost:3000 -u 2000 --spawn-rate 2000 -t 60s --headless

    # ramp/soak: slow spawn lets concurrency climb gradually, then hold
    locust -f locustfile.py -H http://localhost:3000 -u 1000 --spawn-rate 10 -t 10m --headless

    # soak plus final spike: spawn fast to a plateau, then another wave on top
    locust -f locustfile.py -H http://localhost:3000 -u 500 --spawn-rate 100 --run-time 5m --headless
    locust -f locustfile.py -H http://localhost:3000 -u 750 --spawn-rate 750 -t 30s --headless

    # add SSE live-data watchers (background subscribers while purchases run)
    STRESS_SSE_WATCHERS=10 locust -f locustfile.py -H http://localhost:3000 -u 500 --spawn-rate 500 -t 60s --headless

    # hit several active sales at once (vusers round-robin across them)
    STRESS_SALES=flash-sale-001,flash-sale-002,flash-sale-003 \
        locust -f locustfile.py -H http://localhost:3000 -u 600 --spawn-rate 600 -t 60s --headless

    # interactive web UI (http://127.0.0.1:8089): no -t, watch live charts
    locust -f locustfile.py -H http://localhost:3000 -u 200 --spawn-rate 50

On run start every sale in the list is re-armed (purchases wiped, sold_count
zeroed, stock re-seeded, active window set, Redis fast-path flushed), so each
run starts from a clean, live state. On run stop the three invariants are
verified per sale straight from Postgres and a non-zero exit code is set if any
are violated; SSE watchers must each have received at least one live frame.

In queue mode the client only ever sees 202 "accepted", so rows land after the
run: the harness therefore waits for the broker to drain before it reads
Postgres, and it checks the committed winner count in queue mode as well. A
queue that will not drain is reported as VERIFY: PARTIAL (non-zero exit) rather
than a PASS, because a moving target cannot certify anything.

Behavior is tunable through the same env vars the old TS harness used, plus the
multi-sale and SSE additions:
  STRESS_RESET           re-arm the sales before the run      (default "true")
  STRESS_SALES           comma-separated sale ids to hit      (default "flash-sale-001")
  STRESS_USER_SCHEME     "unique" (one id per vuser) or       (default "unique")
                         "flood" (many vusers share a small pool → concurrent
                         duplicates hammer the UNIQUE constraint + Redis 409)
  STRESS_FLOOD_USERS     size of the flood id pool            (default 50)
  SALE_TOTAL_QUANTITY    stock each sale is (re)seeded to     (default 1000)
  STRESS_WINDOW_MINUTES  active window length after re-arm    (default 60)
  SALE_ID                legacy name for a single sale (alias of STRESS_SALES)
  STRESS_SSE_WATCHERS    how many SSE subscribers to spawn    (default 0)
  STRESS_HOST            base URL when -H is not passed       (default "http://localhost:3000")
  STRESS_DRAIN_TIMEOUT   seconds to wait for the queue to      (default 30)
                         empty before verifying (queue mode only)
  STRESS_QUEUE_NAME      BullMQ queue the API writes to       (default "flash-sale-purchases")
  DATABASE_URL / REDIS_URL                                     (local defaults)
"""

import itertools
import os
import time

import gevent
import psycopg
import redis
import requests
from locust import HttpUser, constant, events, task

SALE_ID = os.getenv("SALE_ID", "flash-sale-001")
SALES_RAW = os.getenv("STRESS_SALES", SALE_ID)
SALE_IDS = [s.strip() for s in SALES_RAW.split(",") if s.strip()] or [SALE_ID]
DB_URL = os.getenv("DATABASE_URL", "postgres://flash:flash@localhost:5433/flash_sale")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
STOCK = int(os.getenv("SALE_TOTAL_QUANTITY", "1000"))
WINDOW_MINUTES = int(os.getenv("STRESS_WINDOW_MINUTES", "60"))
REARM = os.getenv("STRESS_RESET", "true").lower() != "false"
USER_SCHEME = os.getenv("STRESS_USER_SCHEME", "unique").lower()
FLOOD_USERS = int(os.getenv("STRESS_FLOOD_USERS", "50"))
SSE_WATCHERS = int(os.getenv("STRESS_SSE_WATCHERS", "0"))
# Queue mode: the client only ever sees 202 "accepted", so the rows land after
# the run. How long to wait for the worker to drain before reading Postgres.
DRAIN_TIMEOUT_S = float(os.getenv("STRESS_DRAIN_TIMEOUT", "30"))
PURCHASE_QUEUE = os.getenv("STRESS_QUEUE_NAME", "flash-sale-purchases")

# BullMQ's key layout, from the library itself
# (bullmq/dist/*/classes/queue-keys.js). The types are spelled out because they
# are not interchangeable — a ZCARD against a list is a WRONGTYPE error, and a
# harness that cannot read the queue cannot say whether it drained:
# `wait`/`active`/`paused`/`waiting-children` are lists (the worker moves jobs
# with RPOPLPUSH), `delayed`/`prioritized` are sorted sets.
BULL_LIST_KEYS = ("wait", "active", "paused", "waiting-children")
BULL_ZSET_KEYS = ("delayed", "prioritized")

# HTTP statuses that are correct, expected flash-sale outcomes — everything
# else (5xx, timeouts, unexpected codes) is a Locust failure.
EXPECTED_CODES = frozenset({201, 400, 404, 409, 410, 425})  # 202 handled below

_user_counter = itertools.count()
_sale_counter = itertools.count()
# Per-sale bookkeeping (greenlet-local atomic adds into sets).
WINS: dict[str, set[str]] = {s: set() for s in SALE_IDS}
STARTED: dict[str, int] = {s: 0 for s in SALE_IDS}
ASSIGNED: dict[str, set[str]] = {s: set() for s in SALE_IDS}
QUEUE_MODE: list[bool] = [False]  # flip when a 202 "accepted" is observed
ACCEPTED: dict[str, int] = {s: 0 for s in SALE_IDS}  # 202 enqueued per sale
# Distinct buyers the broker accepted work for. In queue mode this — not WINS —
# is the population the winner count is computed over: a 202 is the only way a
# row can come to exist, and it is the only commit-shaped answer the client sees.
ACCEPTED_USERS: dict[str, set[str]] = {s: set() for s in SALE_IDS}
SSE_EVENTS: dict[str, int] = {s: 0 for s in SALE_IDS}  # frames received per sale
SSE_ERRORS: list[int] = [0]
SSE_GREENLETS: list[gevent.Greenlet] = []
DEBUG_LOG = os.getenv("STRESS_DEBUG_LOG")  # optional CSV: saleId,userId,status


def _log_resp(sale_id: str, user_id: str, code: int) -> None:
    if DEBUG_LOG:
        with open(DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(f"{sale_id},{user_id},{code}\n")


def _rearm_sales() -> None:
    """Wipe past purchases and reset every sale to a clean, active state."""
    with psycopg.connect(DB_URL) as conn:
        for sale_id in SALE_IDS:
            conn.execute("DELETE FROM purchases WHERE sale_id = %s", (sale_id,))
            conn.execute(
                """
                UPDATE sales
                   SET sold_count = 0,
                       total_quantity = %s,
                       start_at = now() - interval '1 minute',
                       end_at = now() + make_interval(mins => %s),
                       updated_at = now()
                 WHERE id = %s
                """,
                (STOCK, WINDOW_MINUTES, sale_id),
            )
        conn.commit()

    r = redis.Redis.from_url(REDIS_URL)
    for sale_id in SALE_IDS:
        for key in r.scan_iter(f"sale:{sale_id}:purchased:*"):
            r.delete(key)
        r.delete(f"sale:{sale_id}:status")


def _watch_sse(sale_id: str, base_url: str) -> None:
    """Blocking subscriber: hold one SSE connection and count live frames."""
    with requests.Session() as session:
        resp = session.get(
            f"{base_url}/api/sales/{sale_id}/events",
            stream=True,
            timeout=300,
        )
        if resp.status_code != 200:
            SSE_ERRORS[0] += 1
            return
        for raw in resp.iter_lines(decode_unicode=True):
            line = raw.strip()
            if not line or line.startswith(":") or not line.startswith("data: "):
                continue
            SSE_EVENTS[sale_id] += 1


def _spawn_sse_watchers(base_url: str) -> None:
    global SSE_GREENLETS
    for i in range(SSE_WATCHERS):
        sale_id = SALE_IDS[i % len(SALE_IDS)]
        SSE_GREENLETS.append(gevent.spawn(_watch_sse, sale_id, base_url))
    print(
        f"spawned {SSE_WATCHERS} SSE watchers across "
        f"{','.join(SALE_IDS)}"
    )


def _base_url(environment) -> str:  # noqa: ANN001
    host = environment.host or "http://localhost:3000"
    return host.rstrip("/")


@events.test_start.add_listener
def _on_test_start(environment, **kwargs):  # noqa: ANN001, ANN003
    if REARM:
        _rearm_sales()
        print(
            "sales re-armed: purchases cleared, sold_count=0, "
            f"stock={STOCK} each, active window ~{WINDOW_MINUTES}m, "
            "Redis fast-path flushed"
        )
    if SSE_WATCHERS > 0:
        _spawn_sse_watchers(_base_url(environment))


@events.test_stop.add_listener
def _on_test_stop(environment, **kwargs):  # noqa: ANN001, ANN003
    for g in SSE_GREENLETS:
        g.kill(block=False)
    failures, undrained = _verify(environment)
    if failures:
        print("VERIFY: FAIL — invariants broken under load")
        for f in failures:
            print(f"  - {f}")
        if undrained:
            print(f"  ! the queue had not drained, so the counts above were read "
                  f"mid-flight: {undrained}")
        environment.process_exit_code = 1
    elif undrained:
        # Every invariant that could be checked held, but a queue that will not
        # empty means the winner count was compared against a moving target.
        # This used to print a bare PASS. A run that cannot certify itself is not
        # a pass, so it exits non-zero and says why.
        print(
            "VERIFY: PARTIAL — invariants held, but the queue never drained, so "
            f"the winner count is not certified: {undrained} "
            f"({_stats(environment.stats.num_requests)})"
        )
        environment.process_exit_code = 1
    else:
        print(
            "VERIFY: PASS — invariants held under load "
            f"({_stats(environment.stats.num_requests)})"
        )


def _queue_depth(client) -> int:
    """Jobs BullMQ still owns: waiting, in flight, delayed, or paused."""
    depth = sum(client.llen(f"bull:{PURCHASE_QUEUE}:{k}") for k in BULL_LIST_KEYS)
    return depth + sum(client.zcard(f"bull:{PURCHASE_QUEUE}:{k}") for k in BULL_ZSET_KEYS)


def _wait_for_drain() -> tuple[str, float]:
    """Block until the worker has finished everything this run enqueued.

    Verifying before the drain is a false green. In queue mode the response is
    202 and the row appears later, so a stop-time read of Postgres is a snapshot
    of a queue still in flight: during a kill -9 run the harness used to print
    "VERIFY: PASS" while the sale sat at 706 of 1,000. Waiting turns that into
    either a real PASS against a settled sale or an explicit PARTIAL.

    Returns (reason, seconds_waited); reason is "" when the queue emptied.
    """
    started = time.monotonic()
    try:
        client = redis.Redis.from_url(REDIS_URL)
        depth = _queue_depth(client)
    except Exception as err:  # noqa: BLE001
        return (
            f"could not read {PURCHASE_QUEUE} at {REDIS_URL} to check the drain ({err})",
            0.0,
        )
    if depth == 0:
        return "", 0.0
    print(
        f"drain: {PURCHASE_QUEUE} still holds {depth} job(s) at run end; "
        f"waiting up to {DRAIN_TIMEOUT_S:.0f}s for the worker"
    )
    deadline = started + DRAIN_TIMEOUT_S
    while time.monotonic() < deadline:
        try:
            depth = _queue_depth(client)
        except Exception as err:  # noqa: BLE001
            return f"lost contact with the queue while draining ({err})", time.monotonic() - started
        if depth == 0:
            waited = time.monotonic() - started
            return "", waited
        time.sleep(0.25)
    try:
        depth = _queue_depth(client)
    except Exception:  # noqa: BLE001
        depth = -1
    return (
        f"{PURCHASE_QUEUE} still held {depth} job(s) after {DRAIN_TIMEOUT_S:.0f}s",
        time.monotonic() - started,
    )


def _expected_winners(sale_id: str, total: int) -> tuple[int, int]:
    """How many rows this run should have committed, and how many buyers that is.

    Sync mode saw a 201 per winner, so the expectation can be stated against
    every vuser that started: each one is a distinct buyer (unique scheme) or a
    member of the fixed pool (flood), and the sale either serves them all or
    sells out, so min(buyers, stock) rows must exist.

    Queue mode only ever saw 202s, so the population is the distinct buyers the
    broker accepted work for — a 202 is the only way a row can come to exist.
    That is a smaller and *tighter* population than "vusers started": a vuser
    killed by the ramp-down before its first request never asked for anything, and
    a buyer whose requests were all rejected after the window closed never had a
    job. Neither belongs in the expectation, and counting them would fail the run
    for something that has nothing to do with the write path.
    """
    if QUEUE_MODE[0]:
        buyers = len(ACCEPTED_USERS[sale_id])
    elif USER_SCHEME == "flood":
        buyers = len(ASSIGNED[sale_id])
    else:
        buyers = STARTED[sale_id]
    return min(buyers, total), buyers


def _verify(environment) -> tuple[list[str], str | None]:
    """Returns (failures, undrained_reason)."""
    failures = []
    num_requests = environment.stats.num_requests
    # A run that sent nothing verifies nothing. Refusing to print PASS here is
    # the whole point: an aborted run (bad host, unreachable API, every spawn
    # failed) used to re-arm the sales, check a pristine dataset, and report
    # "invariants held under load (0 requests, 0 wins)" with exit code 0.
    if num_requests == 0:
        failures.append(
            f"no load was applied: {num_requests} requests were sent, so the "
            "invariants were never exercised (check -H/STRESS_HOST and that the "
            "API is reachable)"
        )
    if environment.stats.num_failures > num_requests:
        failures.append(
            f"locust recorded {environment.stats.num_failures} failures for only "
            f"{num_requests} requests, which means the stats are inconsistent"
        )
    # Queue mode: the rows land after the response, so Postgres is only ground
    # truth once the broker is empty. Read it settled, not mid-flight.
    undrained = ""
    if QUEUE_MODE[0]:
        undrained, waited = _wait_for_drain()
        if not undrained:
            print(f"drain: {PURCHASE_QUEUE} empty after {waited:.1f}s")
    with psycopg.connect(DB_URL) as conn:
        for sale_id in SALE_IDS:
            (sold, purchases, total) = conn.execute(
                """
                SELECT (SELECT sold_count FROM sales WHERE id = %s),
                       (SELECT count(*) FROM purchases WHERE sale_id = %s),
                       (SELECT total_quantity FROM sales WHERE id = %s)
                """,
                (sale_id, sale_id, sale_id),
            ).fetchone()

            if sold != purchases:
                failures.append(
                    f"[{sale_id}] sold_count={sold} disagrees with purchase rows={purchases}"
                )
            if sold > total:
                failures.append(
                    f"[{sale_id}] OVERSOLD: sold_count={sold} > total_quantity={total}"
                )

            if not QUEUE_MODE[0] and len(WINS[sale_id]) != sold:
                # Sync mode saw a 201 per winner, so the client knows exactly who
                # won and that set has to be the rows.
                failures.append(
                    f"[{sale_id}] {len(WINS[sale_id])} 'purchased' responses "
                    f"but {sold} committed rows"
                )

            # The count check used to sit inside `if not QUEUE_MODE`, so queue
            # mode verified only "rows == sold_count" and "sold_count <= stock".
            # That is how a sale sitting at 706 of 1,000 could be reported as
            # PASS. The count is checkable in both modes: the mode decides which
            # population the expectation is computed over, not whether to check.
            expected, buyers = _expected_winners(sale_id, total)
            if sold != expected:
                population = (
                    "distinct buyers the queue accepted"
                    if QUEUE_MODE[0]
                    else "vusers started"
                )
                failures.append(
                    f"[{sale_id}] sold_count={sold}, expected {expected} winners "
                    f"({buyers} {population}, stock {total})"
                )

    if SSE_WATCHERS > 0:
        for sale_id in SALE_IDS:
            if SSE_EVENTS[sale_id] == 0:
                failures.append(f"[{sale_id}] SSE watchers received no live frame")
        if SSE_ERRORS[0] > 0:
            failures.append(f"{SSE_ERRORS[0]} SSE connection(s) failed to open")

    if environment.stats.num_failures > 0:
        failures.append(f"{environment.stats.num_failures} request failures")
    return failures, undrained or None


def _stats(num_requests: int) -> str:
    wins = sum(len(s) for s in WINS.values())
    sse = sum(SSE_EVENTS.values())
    if QUEUE_MODE[0]:
        accepted = sum(ACCEPTED.values())
        buyers = sum(len(s) for s in ACCEPTED_USERS.values())
        return (
            f"{num_requests} requests, {accepted} accepted "
            f"({buyers} distinct buyers), {sse} SSE frames"
        )
    return f"{num_requests} requests, {wins} wins, {sse} SSE frames"


class FlashSaleUser(HttpUser):
    # A default host so the documented `npm run stress` command works without
    # `-H`. Without it Locust aborts with "You must specify the base host",
    # sends zero requests, and the run still exits 0 with a green VERIFY: PASS —
    # the most expensive way to print a number that means nothing. `STRESS_HOST`
    # or `-H` both override this; the bench harness sets the container port.
    host = os.getenv("STRESS_HOST", "http://localhost:3000")
    wait_time = constant(0)  # no think time: every vuser hammers back-to-back

    def on_start(self) -> None:
        # Round-robin across the configured sales so every sale gets hammered.
        self.sale_id = SALE_IDS[next(_sale_counter) % len(SALE_IDS)]
        STARTED[self.sale_id] += 1
        if USER_SCHEME == "flood":
            # Round-robin over the pool, not random sampling: with a small pool
            # and few vusers, random draws leave some slots unexercised and the
            # expected-winner count becomes unknowable. Round-robin guarantees
            # every pool member is hammered while many vusers still share slots.
            self.user_id = f"flash-flood-{next(_user_counter) % FLOOD_USERS}"
        else:
            self.user_id = f"stress-{next(_user_counter)}"
        ASSIGNED[self.sale_id].add(self.user_id)
        if DEBUG_LOG:
            with open(DEBUG_LOG, "a", encoding="utf-8") as f:
                f.write(f"STARTED,{self.sale_id},{self.user_id}\n")

    @task
    def purchase(self) -> None:
        with self.client.post(
            f"/api/sales/{self.sale_id}/purchase",
            json={"userId": self.user_id},
            catch_response=True,
        ) as resp:
            code = resp.status_code
            _log_resp(self.sale_id, self.user_id, code)
            if code == 201:
                WINS[self.sale_id].add(self.user_id)
                resp.success()
            elif code == 202:
                QUEUE_MODE[0] = True
                ACCEPTED[self.sale_id] += 1
                ACCEPTED_USERS[self.sale_id].add(self.user_id)
                resp.success()
            elif code in EXPECTED_CODES:
                resp.success()
            else:
                resp.failure(f"unexpected HTTP {code}")