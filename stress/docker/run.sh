#!/bin/sh
# Dockerized stress benchmark: run the flash-sale API server in a container
# pinned to a fixed CPU share + memory budget, then load-test it with Locust.
# The cgroup limits make results reproducible across machines / laptop + CI.
#
# Usage (from repo root):
#   npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless
#   STRESS_CPUS=4 STRESS_MEM=512m STRESS_PORT=3001 \
#     npm run bench -s -- -u 1000 --spawn-rate 10 -t 10m --headless
#
# The server talks to the same Postgres + Redis as local dev (it runs on the
# host network, pointing at localhost). Re-arming / verification stay in the
# Locust harness (STRESS_SALES etc.), untouched by this script.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${STRESS_IMAGE:-flash-sale/server:bench}"
CONTAINER="flash-sale-bench"
PORT="${STRESS_PORT:-3000}"
DATABASE_URL="${STRESS_DATABASE_URL:-postgres://flash:flash@localhost:5433/flash_sale}"
REDIS_URL="${STRESS_REDIS_URL:-redis://localhost:6379}"
CPUS="${STRESS_CPUS:-2}"
MEM="${STRESS_MEM:-256m}"
# Optional flag pass-through into the container (e.g. PURCHASE_MODE=queue).
SERVER_ENV="${STRESS_SERVER_ENV:-}"

echo ">> building ${IMAGE} (repo: ${ROOT})"
docker build -q -t "${IMAGE}" -f "${ROOT}/stress/docker/Dockerfile" "${ROOT}"

docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

echo ">> starting server container '${CONTAINER}' (${CPUS} CPUs / ${MEM} mem, port ${PORT})"
# shellcheck disable=SC2086
docker run -d \
  --name "${CONTAINER}" \
  --cpus "${CPUS}" \
  --memory "${MEM}" \
  --network host \
  -e PORT="${PORT}" \
  -e DATABASE_URL="${DATABASE_URL}" \
  -e REDIS_URL="${REDIS_URL}" \
  ${SERVER_ENV} \
  "${IMAGE}" >/dev/null

cleanup() {
  echo ">> stopping '${CONTAINER}'"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo ">> waiting for ${IMAGE} health at http://localhost:${PORT}/healthz"
i=0
until curl -fsS "http://localhost:${PORT}/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "!! server did not become healthy; logs:"
    docker logs "${CONTAINER}" 2>&1 | tail -40 || true
    exit 1
  fi
  sleep 1
done
echo ">> healthy"

echo ">> running Locust against http://localhost:${PORT}"
sh "${ROOT}/stress/locust/run.sh" -H "http://localhost:${PORT}" "$@"