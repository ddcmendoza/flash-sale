#!/bin/sh
# Thin wrapper so `npm run stress -- <flags>` works whether locust is installed
# in the local venv (stress/locust/.venv) or on the PATH.
#
# No -H is added here on purpose: FlashSaleUser.host defaults to
# http://localhost:3000 (override with -H or STRESS_HOST), which is what makes
# the documented `npm run stress -s -- -u 2000 ...` command run as written.
# The bench harness passes its own -H to reach the pinned container.
cd "$(dirname "$0")" || exit 1
if [ -x .venv/bin/locust ]; then
  exec .venv/bin/locust "$@"
fi
exec locust "$@"