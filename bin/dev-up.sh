#!/bin/sh
# One command to run the whole flash-sale demo: Postgres, Redis, the API and the
# web app. Prints a URL, streams the logs, and on Ctrl-C takes the stack back
# down.
#
#   ./bin/dev-up.sh            # build if needed, up, wait for health, stream, Ctrl-C to stop
#   npm run dev:up             # the same thing
#   ./bin/dev-up.sh --fresh    # start from an empty database volume
#   ./bin/dev-up.sh --no-build # reuse the existing images, do not rebuild
#
# If the stack does not come up, this script prints the failing container's name
# and the tail of its logs and then *leaves the containers alone* — a failure
# that deletes its own evidence is not a failure you can debug. It tells you how
# to stop them when you are done.
#
# What it will not do: drop a volume it did not create. The only `-v` this script
# ever passes is behind --fresh, and it is qualified with this compose file's own
# project name, so it can only ever remove this stack's Postgres volume — never a
# volume belonging to the dev stack in infra/docker-compose.yml, which has its
# own project and its own pgdata.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${ROOT}/docker-compose.full.yml"
# Must match `name:` in the compose file. Used to qualify the one destructive
# command below, and as a guard: refuse to touch anything outside this project.
PROJECT="flash-sale-demo"
API_PORT="${API_PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"
LOG_TAIL=60
READY_TIMEOUT=90
DOWN_CMD="docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down"

FRESH=0
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "!! unknown option: ${arg} (try --help)"; exit 1 ;;
  esac
done

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# Set by a failure path to the note the EXIT trap should print *instead of*
# tearing the stack down. A failed start that removes its own containers also
# removes the only evidence of what went wrong, so every failure path routes
# through here: explain first, then leave the evidence in place and say how to
# clear it. Empty means "tear down normally" (the success path, or a usage error).
LEAVE_NOTE=""

# Is this host port published by one of *our own* running containers? Used by the
# port check so that a re-run after a failure does not trip over the leftovers
# of the failed attempt it is meant to retry.
port_is_ours() {
  port=$1
  for svc in api web; do
    cid=$(compose ps -aq "$svc" 2>/dev/null | head -n 1)
    [ -n "$cid" ] || continue
    [ "$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || true)" = "running" ] || continue
    if docker inspect \
      -f '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{.HostPort}} {{end}}{{end}}' \
      "$cid" 2>/dev/null | tr ' ' '\n' | grep -qx "$port"; then
      return 0
    fi
  done
  return 1
}

check_port_free() {
  port=$1
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port" || return 0
  if port_is_ours "$port"; then
    echo ">> host port ${port} is held by this project's own stack; reusing it"
    return 0
  fi
  echo "!! host port ${port} is already in use by something else."
  echo "!! Stop whatever is on it, or pick another:"
  echo "!!   API_PORT=3010 WEB_PORT=5180 $0"
  exit 1
}

# The tail of one service's logs, under a heading that says which container it
# came from. Every failure path routes through here before anything is removed.
show_logs() {
  svc=$1
  cid=$(compose ps -aq "$svc" 2>/dev/null | head -n 1)
  name=$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's|^/||' || true)
  [ -n "$name" ] || name="(container for ${svc} not created)"
  echo "----------------------------------------------------------------"
  echo " >> ${name} (service: ${svc}) — last ${LOG_TAIL} log lines"
  echo "----------------------------------------------------------------"
  compose logs --no-color --tail "$LOG_TAIL" "$svc" 2>&1 | sed 's/^/ | /' || true
  echo
}

# Explain a failed start, in enough detail to act on. Prints the state of every
# container this project owns, then the logs of every container that ran and did
# not come up. Containers that were merely never started (a downstream service
# blocked by a failed dependency) are named as such instead of dumped empty.
explain_failure() {
  reason=$1
  broken=0
  echo
  echo "================================================================"
  echo " !! ${PROJECT} did not start: ${reason}"
  echo "================================================================"
  echo
  echo ">> container states:"
  compose ps -a 2>/dev/null | sed 's/^/   /' || true
  echo

  for svc in postgres redis api web; do
    cid=$(compose ps -aq "$svc" 2>/dev/null | head -n 1)
    if [ -z "$cid" ]; then
      echo ">> ${svc}: no container was created"
      continue
    fi
    state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)
    code=$(docker inspect -f '{{.State.ExitCode}}' "$cid" 2>/dev/null || echo '?')
    echo ">> ${svc}: state=${state} exit=${code}${health:+ health=${health}}"
    case "$state" in
      created)
        echo "   (never started — a dependency of it failed)"
        ;;
      running)
        if [ "$health" = "unhealthy" ]; then
          broken=1
          show_logs "$svc"
        fi
        ;;
      *)
        broken=1
        show_logs "$svc"
        ;;
    esac
  done

  if [ "$broken" -eq 0 ]; then
    echo ">> no container exited and none is unhealthy, so the failure is not in"
    echo ">> the containers themselves. Recent lines from the API and the web app:"
    show_logs api
    show_logs web
  fi

  if [ "$BUILD" -eq 0 ]; then
    echo ">> hint: --no-build reuses whatever image is already present. If the"
    echo ">>       source is newer than that image, this is what you are seeing —"
    echo ">>       re-run without --no-build."
    echo
  fi
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$LEAVE_NOTE" ]; then
    echo
    echo "$LEAVE_NOTE"
    exit $status
  fi
  echo
  echo ">> stopping the ${PROJECT} stack (containers only; the database volume is kept)"
  compose down --remove-orphans >/dev/null 2>&1 || true
  echo ">> stopped. Your database volume (${PROJECT}_pgdata) is still there;"
  echo ">> re-run this script to come back to it, or add --fresh to start over."
  exit $status
}
trap cleanup EXIT INT TERM

# The note every failed-start path ends with: the evidence is still there, and
# here is the exact command that removes it.
leave_note() {
  LEAVE_NOTE=">> nothing was removed. The ${PROJECT} containers are still there so the
>> output above can be inspected:
>>   docker logs <container>
>> When you are done:
>>   ${DOWN_CMD}"
}

check_port_free "$API_PORT"
check_port_free "$WEB_PORT"

if [ "$FRESH" -eq 1 ]; then
  # Qualified with our own project name on purpose: this is the only command here
  # that removes anything, and it can only reach this stack's volume.
  echo ">> --fresh: removing this stack's containers and its ${PROJECT}_pgdata volume"
  compose down -v --remove-orphans >/dev/null
  LEAVE_NOTE=""
fi

if [ "$BUILD" -eq 1 ]; then
  echo ">> building images (first run takes a few minutes; afterwards this is cached)"
  if ! compose build; then
    echo
    echo "!! the image build failed. The compiler output above is the whole story."
    echo "!! No container was created, so there is nothing to inspect or clean up"
    echo "!! beyond the build cache — re-run to try again."
    LEAVE_NOTE=">> no container was created (the build failed first); nothing to stop."
    exit 1
  fi
else
  echo ">> --no-build: using whatever images are already built"
fi

echo ">> starting ${PROJECT}"
leave_note
if ! compose up -d; then
  explain_failure "a container failed to start"
  exit 1
fi

# Wait for the API to be genuinely ready, not merely listening: /readyz checks
# Postgres and Redis too, and the web service is gated on it inside compose, so
# once this returns the browser can complete a purchase.
printf '>> waiting for the API'
ready=0
i=0
while [ "$i" -lt "$READY_TIMEOUT" ]; do
  if curl -fsS -m 2 "http://localhost:${API_PORT}/readyz" 2>/dev/null | grep -q '"status":"ready"'; then
    ready=1
    break
  fi
  printf '.'
  i=$((i + 1))
  sleep 1
done
printf '\n'

if [ "$ready" -ne 1 ]; then
  explain_failure "the API never reported ready on http://localhost:${API_PORT}/readyz"
  exit 1
fi

# Is the SPA actually loadable, not merely served? Vite answers 200 on / even
# when it cannot transform the app's modules — a missing tsconfig, a bad import,
# anything that breaks esbuild shows up as a 500 on the entry module the browser
# asks for next. Probing only / is how a broken app gets announced as running,
# so this fetches index.html and then every module it references.
web_is_loadable() {
  page=$(curl -fsS -m 4 "http://localhost:${WEB_PORT}/" 2>/dev/null) || return 1
  [ -n "$page" ] || return 1
  modules=$(printf '%s\n' "$page" | grep -o 'src="[^"]*"' | sed 's/^src="//; s/"$//')
  [ -n "$modules" ] || return 1
  for m in $modules; do
    curl -fsS -m 4 -o /dev/null "http://localhost:${WEB_PORT}${m}" 2>/dev/null || return 1
  done
  return 0
}

printf '>> waiting for the web app'
web_ok=0
i=0
while [ "$i" -lt "$READY_TIMEOUT" ]; do
  if web_is_loadable; then
    web_ok=1
    break
  fi
  printf '.'
  i=$((i + 1))
  sleep 1
done
printf '\n'

# The banner is the script's claim that the demo works, so it is printed only
# after both ends have answered — never on a best guess.
if [ "$web_ok" -ne 1 ]; then
  explain_failure "the API is ready but the web app does not load on http://localhost:${WEB_PORT}/ (index.html and every module it references must answer 2xx)"
  exit 1
fi

cat <<BANNER

  ┌──────────────────────────────────────────────────────────────┐
  │  Flash sale is running.                                      │
  │                                                              │
  │    Open   http://localhost:${WEB_PORT}                        │
  │    Admin  http://localhost:${WEB_PORT}/#/admin               │
  │    API    http://localhost:${API_PORT}/api/sales             │
  │                                                              │
  │  The web app talks to the API through Vite's /api proxy, so   │
  │  buy from the page, not from the API port.                   │
  └──────────────────────────────────────────────────────────────┘

BANNER

# The stack is verified up, so from here Ctrl-C is the ordinary "stop it" path
# and the EXIT trap should tear down rather than preserve evidence.
LEAVE_NOTE=""

echo ">> streaming logs — press Ctrl-C to stop the stack"
compose logs -f
