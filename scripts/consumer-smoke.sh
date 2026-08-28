#!/usr/bin/env bash
#
# consumer-smoke.sh - build a package whose ONLY data-dependency is the built
# canton-token-forge DAR.
#
# This is the check that guards what a downstream repository actually does: if
# the artifact ever stops being consumable on its own, or the exposure flags
# stop matching what the DAR bundles, this goes red before a release is
# published.
#
# Usage:
#   bash scripts/consumer-smoke.sh   # needs the production DAR already built
#
set -euo pipefail
export LANG="${LANG:-C.UTF-8}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DAR="daml/canton-token-forge/.daml/dist/canton-token-forge-0.0.1.dar"
if [ ! -f "$DAR" ]; then
  echo "missing $DAR - run 'npm run build:canton-token-forge' first" >&2
  exit 1
fi

# Copied, not referenced. Pointing at the build tree would still compile and
# would make this a weaker stand-in than the consumer it represents.
rm -rf consumer-smoke/consumer/vendor consumer-smoke/consumer/.daml
mkdir -p consumer-smoke/consumer/vendor
cp "$DAR" consumer-smoke/consumer/vendor/

( cd consumer-smoke/consumer && dpm build )
echo "consumer smoke test passed: the DAR is consumable standalone"
