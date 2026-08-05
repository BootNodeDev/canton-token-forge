#!/usr/bin/env bash
#
# sandbox.sh - build the production DAR and run a local Canton sandbox with the
# JSON Ledger API enabled, so the registry service and the seed script have a
# live participant to talk to.
#
# Usage:
#   bash scripts/sandbox.sh              # build the DAR, then start the sandbox
#   SKIP_BUILD=1 bash scripts/sandbox.sh # start against the already-built DAR
#
# Runs in the foreground until interrupted. The ports file named below is
# written once every node is up, which is the signal that the sandbox is ready.
#
# Env overrides:
#   JSON_API_PORT     JSON Ledger API port (default 7575)
#   LEDGER_API_PORT   gRPC Ledger API port (default 6865)
#   CANTON_PORT_FILE  where to write the ready/ports file
#   SKIP_BUILD        set to 1 to skip the dpm build step
#
set -euo pipefail

# damlc regenerates data-dependency interface source and fails with a UTF-8
# decoding error under a POSIX/C locale.
export LANG=C.UTF-8

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO_ROOT/daml/canton-token-forge/.daml/dist"
JSON_API_PORT="${JSON_API_PORT:-7575}"
LEDGER_API_PORT="${LEDGER_API_PORT:-6865}"
CANTON_PORT_FILE="${CANTON_PORT_FILE:-$REPO_ROOT/.canton-ports.json}"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm run --prefix "$REPO_ROOT" build:canton-token-forge
fi

# Globbed rather than named: the version comes from daml.yaml, and hardcoding it
# here would report "DAR not found" after a build that just succeeded.
DAR="$(ls -1 "$DIST"/canton-token-forge-*.dar 2>/dev/null | head -n 1)"
if [ -z "$DAR" ]; then
  echo "no DAR in $DIST - run 'npm run build:canton-token-forge' first" >&2
  exit 1
fi

# Refuse to touch a sandbox that is already serving: the ports file below is
# removed on the way in, which would otherwise destroy the running one's
# readiness signal when this launch loses the race for the port.
if curl -sf "http://localhost:$JSON_API_PORT/v2/version" >/dev/null 2>&1; then
  echo "a sandbox is already serving on port $JSON_API_PORT" >&2
  exit 1
fi

# The ports file is this run's readiness signal, so it must not outlive the
# process: a stale one makes a readiness check pass against a dead sandbox.
SANDBOX_PID=""
cleanup() {
  if [ -n "$SANDBOX_PID" ]; then
    # Signal the whole process group, not just dpm: dpm runs Canton as a child
    # of its own and does not forward signals, so killing dpm alone would orphan
    # a live JVM while the ports file below is removed.
    kill -TERM -"$SANDBOX_PID" 2>/dev/null || true
    wait "$SANDBOX_PID" 2>/dev/null || true
  fi
  rm -f "$CANTON_PORT_FILE"
}
trap cleanup EXIT INT TERM

rm -f "$CANTON_PORT_FILE"

echo "starting Canton sandbox: JSON Ledger API on http://localhost:$JSON_API_PORT"
echo "ready when $CANTON_PORT_FILE appears; stop with Ctrl-C"

# Backgrounded and waited on rather than run in the foreground: bash defers trap
# handlers until a foreground child exits, which would leave the sandbox running
# and the ports file behind on SIGTERM. Job control is enabled just long enough
# to give the sandbox its own process group for cleanup() to signal.
set -m
dpm sandbox \
  --dar "$DAR" \
  --json-api-port "$JSON_API_PORT" \
  --ledger-api-port "$LEDGER_API_PORT" \
  --canton-port-file "$CANTON_PORT_FILE" &
SANDBOX_PID=$!
set +m
wait "$SANDBOX_PID"
