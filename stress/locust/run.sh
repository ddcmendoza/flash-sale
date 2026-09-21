#!/bin/sh
# Thin wrapper so `npm run stress -- <flags>` works whether locust is installed
# in the local venv (stress/locust/.venv) or on the PATH.
cd "$(dirname "$0")" || exit 1
if [ -x .venv/bin/locust ]; then
  exec .venv/bin/locust "$@"
fi
exec locust "$@"