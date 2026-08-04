#!/usr/bin/env bash
#
# sandbox.sh - build the production DAR and run a local Canton sandbox with the
# JSON Ledger API enabled, so the registry service and the seed script have a
# live participant to talk to. This is the Canton sandbox, unrelated to
# docs/bootstrap-sandbox.sh (which provisions a Claude Code container).
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
DAR="$REPO_ROOT/daml/canton-token-forge/.daml/dist/canton-token-forge-0.0.1.dar"
JSON_API_PORT="${JSON_API_PORT:-7575}"
LEDGER_API_PORT="${LEDGER_API_PORT:-6865}"
CANTON_PORT_FILE="${CANTON_PORT_FILE:-$REPO_ROOT/.canton-ports.json}"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  ( cd "$REPO_ROOT/daml/canton-token-forge" && dpm build )
fi

if [ ! -f "$DAR" ]; then
  echo "DAR not found at $DAR - run 'npm run build:canton-token-forge' first" >&2
  exit 1
fi

# A stale ports file would make a readiness check pass before the nodes are up.
rm -f "$CANTON_PORT_FILE"

echo "starting Canton sandbox: JSON Ledger API on http://localhost:$JSON_API_PORT"
echo "ready when $CANTON_PORT_FILE appears; stop with Ctrl-C"

exec dpm sandbox \
  --dar "$DAR" \
  --json-api-port "$JSON_API_PORT" \
  --ledger-api-port "$LEDGER_API_PORT" \
  --canton-port-file "$CANTON_PORT_FILE"
