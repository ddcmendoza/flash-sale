"""
Locust load-test for the flash-sale API.

The Locust CLI is the entire load-shaping surface — different kinds of load are
just flags:

    # instant burst: 2,000 users all spawn as fast as possible, run 60s
    locust -f locustfile.py -H http://localhost:3000 -u 2000 --spawn-rate 2000 -t 60s --headless

    # ramp/soak: slow spawn lets concurrency climb gradually, then hold
    locust -f locustfile.py -H http://localhost:3000 -u 1000 --spawn-rate 10 -t 10m --headless

    # soak plus final spike: spawn fast to a plateau, then another wave on top
    locust -f locustfile.py -H http://localhost:3000 -u 500 --spawn-rate 100 --run-time 5m --headless
    locust -f locustfile.py -H http://localhost:3000 -u 750 --spawn-rate 750 -t 30s --headless

    # interactive web UI (http://127.0.0.1:8089): no -t, watch live charts
    locust -f locustfile.py -H http://localhost:3000 -u 200 --spawn-rate 50

On run start the sale is re-armed (purchases wiped, sold_count zeroed, stock
re-seeded, active window set, Redis fast-path flushed), so every run starts
from a clean, live state. On run stop the three invariants are verified
straight from Postgres and a non-zero exit code is set if any are violated.

Behavior is tunable through the same env vars the old TS harness used:
  STRESS_RESET          re-arm the sale before the run        (default "true")
  STRESS_USER_SCHEME    "unique" (one id per vuser) or        (default "unique")
                       "flood" (many vusers share a small pool → concurrent
                       duplicates hammer the UNIQUE constraint + Redis 409)
  STRESS_FLOOD_USERS    size of the flood id pool             (default 50)
  SALE_TOTAL_QUANTITY   stock the sale is (re)seeded to       (default 1000)
  STRESS_WINDOW_MINUTES active window length after re-arm     (default 60)
  SALE_ID               sale row to hit                       (default flash-sale-001)
  DATABASE_URL / REDIS_URL                                     (local defaults)
"""

import itertools
import os

import psycopg
import redis
from locust import HttpUser, constant, events, task

SALE_ID = os.getenv("SALE_ID", "flash-sale-001")
DB_URL = os.getenv("DATABASE_URL", "postgres://flash:flash@localhost:5433/flash_sale")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
STOCK = int(os.getenv("SALE_TOTAL_QUANTITY", "1000"))
WINDOW_MINUTES = int(os.getenv("STRESS_WINDOW_MINUTES", "60"))
REARM = os.getenv("STRESS_RESET", "true").lower() != "false"
USER_SCHEME = os.getenv("STRESS_USER_SCHEME", "unique").lower()
FLOOD_USERS = int(os.getenv("STRESS_FLOOD_USERS", "50"))

# HTTP statuses that are correct, expected flash-sale outcomes — everything
# else (5xx, timeouts, unexpected codes) is a Locust failure.
EXPECTED_CODES = frozenset({201, 400, 404, 409, 410, 425})  # 202 handled below

_user_counter = itertools.count()
WINS: set[str] = set()  # user ids that received a 201 (greenlet-local: atomic adds)
QUEUE_MODE: list[bool] = [False]  # flip when a 202 "accepted" is observed
STARTED = [0]  # virtual users that did on_start
ASSIGNED: set[str] = set()  # pool ids actually held by at least one vuser
DEBUG_LOG = os.getenv("STRESS_DEBUG_LOG")  # optional CSV: userId,status


def _log_resp(user_id: str, code: int) -> None:
    if DEBUG_LOG:
        with open(DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(f"{user_id},{code}\n")


def _rearm_sale() -> None:
    """Wipe past purchases and set the sale to a clean, active state."""
    with psycopg.connect(DB_URL) as conn:
        conn.execute("DELETE FROM purchases WHERE sale_id = %s", (SALE_ID,))
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
            (STOCK, WINDOW_MINUTES, SALE_ID),
        )
        conn.commit()

    r = redis.Redis.from_url(REDIS_URL)
    for key in r.scan_iter(f"sale:{SALE_ID}:purchased:*"):
        r.delete(key)
    r.delete(f"sale:{SALE_ID}:status")


@events.test_start.add_listener
def _on_test_start(environment, **kwargs):  # noqa: ANN001, ANN003
    if REARM:
        _rearm_sale()
        print(
            "sale re-armed: purchases cleared, sold_count=0, "
            f"stock={STOCK}, active window ~{WINDOW_MINUTES}m, Redis fast-path flushed"
        )


@events.test_stop.add_listener
def _on_test_stop(environment, **kwargs):  # noqa: ANN001, ANN003
    failures = _verify(environment)
    if failures:
        print("VERIFY: FAIL — invariants broken under load")
        for f in failures:
            print(f"  - {f}")
        environment.process_exit_code = 1
    else:
        print(
            "VERIFY: PASS — invariants held under load "
            f"({_stats(environment.stats.num_requests)})"
        )


def _verify(environment):
    failures = []
    with psycopg.connect(DB_URL) as conn:
        (sold, purchases, total) = conn.execute(
            """
            SELECT (SELECT sold_count FROM sales WHERE id = %s),
                   (SELECT count(*) FROM purchases WHERE sale_id = %s),
                   (SELECT total_quantity FROM sales WHERE id = %s)
            """,
            (SALE_ID, SALE_ID, SALE_ID),
        ).fetchone()

    if sold != purchases:
        failures.append(f"sold_count={sold} disagrees with purchase rows={purchases}")
    if sold > total:
        failures.append(f"OVERSOLD: sold_count={sold} > total_quantity={total}")

    if not QUEUE_MODE[0]:
        if len(WINS) != sold:
            failures.append(
                f"{len(WINS)} 'purchased' responses but {sold} committed rows"
            )
        expected = (
            min(STARTED[0], total)
            if USER_SCHEME != "flood"
            else min(len(ASSIGNED), total)
        )
        if sold != expected:
            failures.append(f"sold_count={sold}, expected {expected} winners")

    if environment.stats.num_failures > 0:
        failures.append(f"{environment.stats.num_failures} request failures")
    return failures


def _stats(num_requests: int) -> str:
    return f"{num_requests} requests, {len(WINS)} wins"


class FlashSaleUser(HttpUser):
    wait_time = constant(0)  # no think time: every vuser hammers back-to-back

    def on_start(self) -> None:
        STARTED[0] += 1
        if USER_SCHEME == "flood":
            # Round-robin over the pool, not random sampling: with a small pool
            # and few vusers, random draws leave some slots unexercised and the
            # expected-winner count becomes unknowable. Round-robin guarantees
            # every pool member is hammered while many vusers still share slots.
            self.user_id = f"flash-flood-{next(_user_counter) % FLOOD_USERS}"
        else:
            self.user_id = f"stress-{next(_user_counter)}"
        ASSIGNED.add(self.user_id)
        if DEBUG_LOG:
            with open(DEBUG_LOG, "a", encoding="utf-8") as f:
                f.write(f"STARTED,{self.user_id},total={STARTED[0]}\n")

    @task
    def purchase(self) -> None:
        with self.client.post(
            "/api/purchase",
            json={"userId": self.user_id},
            catch_response=True,
        ) as resp:
            code = resp.status_code
            _log_resp(self.user_id, code)
            if code == 201:
                WINS.add(self.user_id)
                resp.success()
            elif code == 202:
                QUEUE_MODE[0] = True
                resp.success()
            elif code in EXPECTED_CODES:
                resp.success()
            else:
                resp.failure(f"unexpected HTTP {code}")