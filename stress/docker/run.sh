#!/bin/sh
# Dockerized stress benchmark: run the flash-sale API server in a container
# pinned to a fixed CPU share + memory budget, then load-test it with Locust.
# The cgroup limits make results reproducible across machines / laptop + CI.
#
# Usage (from repo root):
#   npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless
#   STRESS_CPUS=4 STRESS_MEM=512m STRESS_PORT=3001 \
#     npm run bench -s -- -u 1000 --spawn-rate 10 -t 10m --headless
#   STRESS_MODE=queue npm run bench -s -- -u 2000 --spawn-rate 2000 -t 60s --headless
#
# Networking: we publish the container's port to the host (-p), NOT --network
# host. On Docker Desktop the container runs inside a VM network namespace, so
# --network host binds to the VM loopback (192.168.65.x) which your host's
# localhost never reaches; published ports are the only ones Docker Desktop
# actually forwards. host.docker.internal is used to reach host Postgres/Redis
# (native Linux gets it via --add-host host-gateway).
#
# Port selection: starts at 3000 (or STRESS_PORT when set). docker run fails
# fast if another service already publishes that host port, so we retry on the
# next port until the real flash-sale API answers the health probe.
#
# The server talks to the same Postgres + Redis as local dev. Re-arming /
# verification stay in the Locust harness (STRESS_SALES etc.), untouched here.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# sync (default) or queue; selects Dockerfile + image tag below.
MODE="${STRESS_MODE:-sync}"
case "${MODE}" in
  sync)  DOCKERFILE="Dockerfile";  IMAGE_TAG="flash-sale/server:bench";;
  queue) DOCKERFILE="Dockerfile.queue"; IMAGE_TAG="flash-sale/server:bench-queue";;
  *) echo "!! STRESS_MODE must be 'sync' or 'queue' (got '${MODE}')"; exit 1;;
esac
IMAGE="${STRESS_IMAGE:-${IMAGE_TAG}}"
CONTAINER="flash-sale-bench"
DATABASE_URL="${STRESS_DATABASE_URL:-postgres://flash:flash@host.docker.internal:5433/flash_sale}"
REDIS_URL="${STRESS_REDIS_URL:-redis://host.docker.internal:6379}"
CPUS="${STRESS_CPUS:-2}"
MEM="${STRESS_MEM:-256m}"
# Optional flag pass-through into the container (e.g. PURCHASE_MODE=queue).
SERVER_ENV="${STRESS_SERVER_ENV:-}"
PORT="${STRESS_PORT:-3000}"

echo ">> building ${IMAGE} (${MODE} mode, repo: ${ROOT})"
docker build -q -t "${IMAGE}" -f "${ROOT}/stress/docker/${DOCKERFILE}" "${ROOT}"

cleanup() {
  echo ">> stopping '${CONTAINER}'"
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

# Try up to 10 ports: {PORT}..{PORT+9}. First one where the API health body
# comes back through the published host port wins.
tried=0
found=""
while [ "$tried" -lt 10 ] && [ -z "$found" ]; do
  if [ "$tried" -gt 0 ]; then
    PORT=$((PORT + 1))
    echo ">> port ${PORT} not usable; trying ${PORT}"
  fi
  tried=$((tried + 1))

  echo ">> starting server container '${CONTAINER}' (${CPUS} CPUs / ${MEM} mem, port ${PORT})"
  # Publish the port and alias host.docker.internal to the host gateway (no-op
  # on Docker Desktop which provides it natively; required on plain Linux Docker).
  if ! docker run -d \
    --name "${CONTAINER}" \
    --cpus "${CPUS}" \
    --memory "${MEM}" \
    --add-host host.docker.internal:host-gateway \
    -p "${PORT}:${PORT}" \
    -e PORT="${PORT}" \
    -e DATABASE_URL="${DATABASE_URL}" \
    -e REDIS_URL="${REDIS_URL}" \
    ${SERVER_ENV} \
    "${IMAGE}" >/dev/null 2>"${ROOT}/stress/docker/.run.err"; then
    reason="$(grep -oE 'Bind for 0.0.0.0:[0-9]+ failed|port is already allocated|address already in use' "${ROOT}/stress/docker/.run.err" 2>/dev/null | tail -1)"
    [ -n "$reason" ] || reason="$(tail -1 "${ROOT}/stress/docker/.run.err" 2>/dev/null)"
    echo "!! docker run failed (${CONTAINER}): ${reason}"
    # A failed -d run can still create the container record; drop it so the
    # next attempt can reuse the name.
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    rm -f "${ROOT}/stress/docker/.run.err"
    continue
  fi
  rm -f "${ROOT}/stress/docker/.run.err"

  echo ">> waiting for health at http://localhost:${PORT}/healthz"
  waited=0
  while [ "$waited" -lt 12 ]; do
    if [ "$(curl -fsS "http://localhost:${PORT}/healthz" 2>/dev/null)" = '{"status":"ok"}' ]; then
      found="${PORT}"
      break
    fi
    waited=$((waited + 1))
    sleep 1
  done

  if [ -n "$found" ]; then
    echo ">> healthy on port ${PORT}"
    break
  fi

  echo "!! port ${PORT} did not answer as the flash-sale API; container logs:"
  docker logs "${CONTAINER}" 2>&1 | tail -8 || true
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
done

if [ -z "$found" ]; then
  echo "!! no publishable port in ${PORT}..$((PORT + 9)) — is another stack squatting"
  echo "!! them all? pick a well-isolated port, e.g. STRESS_PORT=3015 npm run bench"
  exit 1
fi
PORT="$found"

echo ">> running Locust against http://localhost:${PORT}"
sh "${ROOT}/stress/locust/run.sh" -H "http://localhost:${PORT}" "$@"