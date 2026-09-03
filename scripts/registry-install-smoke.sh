#!/usr/bin/env bash
set -euo pipefail

# registry-install-smoke.sh - pack the repository, install the tarball into a
# scratch consumer, and run the bin that install links.
#
# This is the npm counterpart of `npm run smoke`, which proves the same thing
# about the DAR: it is the only check here that exercises what a consumer
# actually receives. What it guards is what a green build cannot see: a file
# `files` failed to pack, a spec that ships but does not parse, a module system
# the package cannot be loaded under, a bin pointing at nothing.
#
# It does NOT establish that the root manifest declares every runtime import.
# `express` is a peer dependency of `express-openapi-validator`, so npm installs
# it at the consumer's top level and the service runs whether or not the root
# names it; comparing the two manifests is `npm run check:deps`'s job.
#
# No participant is needed. The boot fails only for a fault it can attribute to
# our own configuration, so an unreachable ledger warns and continues, and
# /healthz answers without touching it.
#
# Usage:
#   npm run smoke:registry
#
# Requires a root `npm install` first, since npm pack runs prepare and prepare
# needs tsc, and network for the consumer install. Rewrites registry/dist as a
# side effect, which `npm run clean` removes.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
server_pid=""

cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
# A signal has to end the run rather than return into it, because by then
# cleanup has removed the work directory the next line would read. Exiting here
# lets the EXIT trap do the one cleanup, with the conventional signal status.
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "smoke: $*" >&2; exit 1; }

# Print a captured body, ending it with a newline whether or not it has one, so
# the smoke: line that follows starts a line of its own. A JSON error body and a
# log a crash cut off mid-write both arrive without a trailing newline.
dump() {
  if [ -s "$1" ]; then
    cat "$1" >&2
    [ -z "$(tail -c 1 "$1")" ] || echo >&2
  fi
}

# A port nothing is listening on. Asking the kernel for one and closing it
# immediately races with anything else on the machine, which is why the closed
# port is only ever connected TO and the served port is asserted by polling.
free_port() {
  node -e 'const net = require("node:net"); const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => console.log(p)) })'
}

echo "smoke: packing ${repo_root}"
# npm pack runs `prepare`, so the tarball carries a build made from the source
# in this tree rather than whatever registry/dist happened to hold.
# A compile error in prepare is the likeliest way this whole check fails, so
# the status is held rather than left to set -e, which would end the run here
# with nothing said. --silent is deliberately not passed: it silences the
# prepare script too, which is where the compiler names the file and the line.
# Which stream carries that depends on the npm version. npm 9 keeps everything
# but the tarball name on stderr; npm 10 runs prepare in the foreground and
# writes its banner, and a failing compiler's output, to stdout. So both streams
# are captured, both are printed on failure, and the name is the LAST line of
# stdout rather than the whole of it.
set +e
( cd "$repo_root" && npm pack --pack-destination "$work" ) \
  >"${work}/pack.out" 2>"${work}/pack.err"
pack_status=$?
set -e
if [ "$pack_status" -ne 0 ]; then
  dump "${work}/pack.out"
  dump "${work}/pack.err"
  fail "npm pack failed with exit ${pack_status}"
fi
tarball_name="$(tail -n 1 "${work}/pack.out")"
tarball="${work}/${tarball_name}"
[ -f "$tarball" ] || fail "npm pack produced no tarball at ${tarball}"

# The bin and the OpenAPI specs are the two things `files` can silently drop:
# a nested .gitignore outranks the root allowlist for a path inside it, and the
# validator reads its spec lazily, so a spec left out of the tarball is a 500
# on the first request rather than a boot failure. Both are asserted here on
# the archive itself, before anything installs it.
listing="$(tar tzf "$tarball")"
for entry in \
  package/registry/dist/index.js \
  package/registry/openapi/token-metadata-v1.yaml \
  package/registry/openapi/transfer-instruction-v1.yaml \
  package/registry/openapi/allocation-v1.yaml \
  package/registry/openapi/allocation-instruction-v1.yaml
do
  grep -qxF "$entry" <<<"$listing" || fail "the tarball carries no ${entry#package/}"
done

# The consumer lives outside the repository so npm resolves against its own
# manifest instead of walking up into ours.
consumer="${work}/consumer"
mkdir -p "$consumer"
cat > "${consumer}/package.json" <<'JSON'
{
  "name": "registry-install-smoke-consumer",
  "version": "0.0.0",
  "private": true
}
JSON

echo "smoke: installing ${tarball_name}"
# --silent is left off for the same reason as the pack above, and here it is
# npm's own error that it would suppress: a silenced install failure prints
# nothing at all, on either stream. This is the step the network prerequisite
# can fail, so the status is held and the captured output printed.
set +e
( cd "$consumer" && npm install --no-audit --no-fund "$tarball" ) \
  >"${work}/install.log" 2>&1
install_status=$?
set -e
if [ "$install_status" -ne 0 ]; then
  dump "${work}/install.log"
  fail "installing the tarball failed with exit ${install_status}"
fi

bin="${consumer}/node_modules/.bin/canton-token-forge-registry"
[ -x "$bin" ] || fail "the install linked no executable bin at ${bin}"

echo "smoke: running with no configuration"
# The logger writes to stdout, so the streams are joined rather than asserted
# on stderr, where nothing would ever appear.
set +e
# index.ts loads dotenv/config, which reads $PWD/.env: run from the consumer
# directory so this asserts on a clean environment instead of whatever .env
# happens to sit in the caller's own working directory. env -i clears every
# inherited variable so a LEDGER_API_URL exported outside this script can't
# shift the failure past the one asserted below.
no_config_output="$( cd "$consumer" && env -i PATH="$PATH" "$bin" 2>&1 )"
no_config_status=$?
set -e
[ "$no_config_status" -eq 1 ] \
  || fail "expected exit 1 with no configuration, got ${no_config_status}"
case "$no_config_output" in
  *"missing required env var LEDGER_API_URL"*) ;;
  *) fail "expected the missing LEDGER_API_URL message, got: ${no_config_output}" ;;
esac

echo "smoke: running against an unreachable participant"
serve_port="$(free_port)"
dead_port="$(free_port)"
prefix='#canton-token-forge:Canton.TokenForge'
# Same $PWD/.env concern as the no-config run above, and env -i for the same
# reason: passing the configuration through it makes these variables the only
# ones the service sees, so an optional one exported in the caller's shell
# (SHUTDOWN_TIMEOUT_MS, NODE_OPTIONS) cannot change what this run tests.
( cd "$consumer" && exec env -i \
PATH="$PATH" \
LEDGER_API_URL="http://127.0.0.1:${dead_port}" \
LEDGER_API_TOKEN=smoke \
ADMIN_PARTY='admin::1220smoke' \
INSTRUMENT_CONFIG_TEMPLATE_ID="${prefix}.Registry:InstrumentConfig" \
TRANSFER_INSTRUCTION_TEMPLATE_ID="${prefix}.Instruction:TokenTransferInstruction" \
PREAPPROVAL_TEMPLATE_ID="${prefix}.Registry:TokenTransferPreapproval" \
LOCKED_TOKEN_TEMPLATE_ID="${prefix}.Locked:LockedToken" \
ALLOCATION_TEMPLATE_ID="${prefix}.Allocation:TokenAllocation" \
PORT="${serve_port}" \
  "$bin" ) > "${work}/server.log" 2>&1 &
server_pid=$!

health=""
for _ in $(seq 1 60); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    dump "${work}/server.log"
    fail "the service exited before it listened"
  fi
  health="$(curl -sf "http://127.0.0.1:${serve_port}/healthz" || true)"
  [ -n "$health" ] && break
  sleep 0.5
done
[ -n "$health" ] || { dump "${work}/server.log"; fail "no 200 from /healthz on port ${serve_port}"; }
case "$health" in
  *'"status":"ok"'*) ;;
  *) fail "unexpected /healthz body: ${health}" ;;
esac

# /healthz is served before any validator, so it says nothing about the specs.
# /registry/metadata/v1/info is the cheapest request that passes through one of
# them and answers from configuration alone, so it needs no ledger: it is 200
# with the specs shipped and 500 ("spec could not be read") without them.
# || true so a service that died between the poll above and this request is
# reported by the status check below (curl writes 000 and exits non-zero on a
# refused connection) rather than aborting the run silently through set -e.
info_status="$(curl -s -o "${work}/info.json" -w '%{http_code}' \
  "http://127.0.0.1:${serve_port}/registry/metadata/v1/info" || true)"
[ "$info_status" = "200" ] \
  || { dump "${work}/info.json"; fail "expected 200 from /registry/metadata/v1/info, got ${info_status}"; }

echo "smoke: terminating"
# A service that died between serving the two requests above and this line is a
# real failure, and an unguarded kill would report it as set -e ending the run
# on bash's own "no such process" rather than as something this check saw.
if ! kill -TERM "$server_pid" 2>/dev/null; then
  dump "${work}/server.log"
  fail "the service was already gone when the run asked it to shut down"
fi
set +e
wait "$server_pid"
shutdown_status=$?
set -e
server_pid=""
[ "$shutdown_status" -eq 0 ] \
  || fail "expected a clean exit on SIGTERM, got ${shutdown_status}"

echo "smoke: ok (${tarball_name} installs, refuses an empty environment, serves /healthz and the metadata API, and shuts down cleanly)"
