"""
Postgres ground-truth verification for a finished flash-sale load run.

Runs independently of the load generator (Locust or anything else): it trusts
the HTTP responses only as far as the database counters agree. Used as a CI
gate after a headless run:

    locust -f locustfile.py -H http://localhost:3000 -u 2000 --spawn-rate 500 -t 60s --headless
    python verify.py

Env: DATABASE_URL, SALE_ID. Exit code 0 = invariants held, 1 = broken.
"""

import os
import sys

import psycopg

SALE_ID = os.getenv("SALE_ID", "flash-sale-001")
DB_URL = os.getenv("DATABASE_URL", "postgres://flash:flash@localhost:5433/flash_sale")


def main() -> int:
    with psycopg.connect(DB_URL) as conn:
        (sold, purchases, total) = conn.execute(
            """
            SELECT (SELECT sold_count FROM sales WHERE id = %s),
                   (SELECT count(*) FROM purchases WHERE sale_id = %s),
                   (SELECT total_quantity FROM sales WHERE id = %s)
            """,
            (SALE_ID, SALE_ID, SALE_ID),
        ).fetchone()
        winners = conn.execute(
            "SELECT count(DISTINCT user_id) FROM purchases WHERE sale_id = %s",
            (SALE_ID,),
        ).fetchone()[0]

    failures = []
    if sold != purchases:
        failures.append(
            f"sold_count={sold} disagrees with purchase rows={purchases}"
        )
    if sold > total:
        failures.append(f"OVERSOLD: sold_count={sold} > total_quantity={total}")
    if winners != sold:
        failures.append(
            f"distinct winning users={winners} disagrees with sold_count={sold}"
        )

    print("Postgres ground truth")
    print("-" * 60)
    print(f"  sold_count         : {sold}")
    print(f"  purchase rows      : {purchases}")
    print(f"  distinct winners   : {winners}")
    print(f"  total_quantity     : {total}")

    if failures:
        print("\nRESULT: FAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nRESULT: PASS — invariants held")
    return 0


if __name__ == "__main__":
    sys.exit(main())