#!/usr/bin/env bash
#
# consumer-smoke.sh - build a package whose ONLY data-dependency is the built
# canton-token-forge DAR.
#
# This is the check that guards what a downstream repository actually does: that
# the artifact is consumable on its own, and that the exposure flags still match
# what the DAR bundles. Nothing runs it automatically, so run it before
# publishing a release.
#
# Usage:
#   bash scripts/consumer-smoke.sh              # build the DAR, then compile against it
#   SKIP_BUILD=1 bash scripts/consumer-smoke.sh # compile against the already-built DAR
#
# Env overrides:
#   SKIP_BUILD        set to 1 to skip the dpm build step
#
set -euo pipefail
export LANG="${LANG:-C.UTF-8}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DIST="daml/canton-token-forge/.daml/dist"

# Building by default is what keeps the result honest: the step below reads
# whatever DAR is on disk, and a stale one passes while describing source that
# is no longer there.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm run build:canton-token-forge
fi

# Globbed rather than named: the version comes from daml.yaml, and hardcoding it
# here would report "DAR not found" after a build that just succeeded. An absent
# dist directory makes ls exit non-zero, which under pipefail would kill the
# script before the message below ever runs.
DAR="$(ls -1 "$DIST"/canton-token-forge-*.dar 2>/dev/null | head -n 1 || true)"
if [ -z "$DAR" ]; then
  echo "no DAR in $DIST - run 'npm run build:canton-token-forge' first" >&2
  exit 1
fi

# Copied, not referenced. Pointing at the build tree would still compile and
# would make this a weaker stand-in than the consumer it represents. The
# version-free destination name is what keeps the version out of the consumer's
# daml.yaml.
rm -rf consumer-smoke/consumer/vendor consumer-smoke/consumer/.daml
mkdir -p consumer-smoke/consumer/vendor
cp "$DAR" consumer-smoke/consumer/vendor/canton-token-forge.dar

( cd consumer-smoke/consumer && dpm build )
echo "consumer smoke test passed: the DAR is consumable standalone"
