"""
Postgres ground-truth verification for a finished flash-sale load run.

Runs independently of the load generator (Locust or anything else): it trusts
the HTTP responses only as far as the database counters agree. Used as a CI
gate after a headless run:

    locust -f locustfile.py -H http://localhost:3000 -u 2000 --spawn-rate 500 -t 60s --headless
    python verify.py

Env: DATABASE_URL, STRESS_SALES (comma-separated sale ids; SALE_ID is the
legacy single-sale alias). Exit code 0 = invariants held, 1 = broken.
"""

import os
import sys

import psycopg

SALE_ID = os.getenv("SALE_ID", "flash-sale-001")
SALES_RAW = os.getenv("STRESS_SALES", SALE_ID)
SALE_IDS = [s.strip() for s in SALES_RAW.split(",") if s.strip()] or [SALE_ID]
DB_URL = os.getenv("DATABASE_URL", "postgres://flash:flash@localhost:5433/flash_sale")


def check_sale(conn: psycopg.Connection, sale_id: str) -> list[str]:  # noqa: ANN001
    (sold, purchases, total) = conn.execute(
        """
        SELECT (SELECT sold_count FROM sales WHERE id = %s),
               (SELECT count(*) FROM purchases WHERE sale_id = %s),
               (SELECT total_quantity FROM sales WHERE id = %s)
        """,
        (sale_id, sale_id, sale_id),
    ).fetchone()
    winners = conn.execute(
        "SELECT count(DISTINCT user_id) FROM purchases WHERE sale_id = %s",
        (sale_id,),
    ).fetchone()[0]

    failures = []
    if sold != purchases:
        failures.append(
            f"[{sale_id}] sold_count={sold} disagrees with purchase rows={purchases}"
        )
    if sold > total:
        failures.append(f"[{sale_id}] OVERSOLD: sold_count={sold} > total_quantity={total}")
    if winners != sold:
        failures.append(
            f"[{sale_id}] distinct winning users={winners} disagrees with sold_count={sold}"
        )

    print(f"  {sale_id}: sold_count={sold}  purchase rows={purchases}  "
          f"distinct winners={winners}  total_quantity={total}")
    return failures


def main() -> int:
    failures: list[str] = []
    print("Postgres ground truth")
    print("-" * 60)
    with psycopg.connect(DB_URL) as conn:
        for sale_id in SALE_IDS:
            failures.extend(check_sale(conn, sale_id))

    if failures:
        print("\nRESULT: FAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nRESULT: PASS — invariants held")
    return 0


if __name__ == "__main__":
    sys.exit(main())