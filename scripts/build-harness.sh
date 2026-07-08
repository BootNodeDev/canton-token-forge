#!/bin/bash
# Build the upstream splice-amulet-test bootstrap DAR that the splice-app-test
# integration suite data-depends on. Run AFTER scripts/fetch-dep.sh.
#
# WHY: the AmuletRegistry test engine (setupApp / tap / getAppTransferContext ...)
# ships only as SOURCE and data-depends on *-current.dar artifacts the repo does
# not ship. We ALIAS those -current.dar names at the shipped, byte-verified
# versioned DARs (same package-ids the production package uses) via the stable
# symlinks fetch-dep created, and build only the three source-only test packages.
# Version-free: the SDK is read from the vendored harness, DAR versions come from
# the stable symlinks, freshly built DAR names are globbed.
set -euo pipefail
export LANG="${LANG:-C.UTF-8}"
export LC_ALL="${LC_ALL:-C.UTF-8}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DARS="$ROOT/deps/splice-daml/dars"

if [ ! -d deps/token-standard/splice-token-standard-test ]; then
  echo "deps/token-standard missing - run scripts/fetch-dep.sh first." >&2; exit 1
fi
for l in splice-amulet splice-util splice-api-reward-assignment-v1; do
  if [ ! -f "$DARS/$l.dar" ]; then
    echo "stable symlink $DARS/$l.dar missing - run scripts/fetch-dep.sh first." >&2; exit 1
  fi
done

# Same daml/<->token-standard sibling shim as fetch-dep (idempotent).
ln -sfn splice-daml deps/daml

# dpm discovers a multi-package.yaml by walking UP from the package dir. Without
# this, building a vendored package under deps/ would walk up to the repo-root
# multi-package.yaml (which lists only the splice-app packages, not these), and
# fail with "Failed to find DPM package resolution". Placing a nearer
# multi-package.yaml here that lists the three source-only test packages scopes
# each build correctly. deps/ is gitignored, so this scratch file is never committed.
cat > deps/multi-package.yaml <<'MPEOF'
packages:
  - ./token-standard/examples/splice-token-test-trading-app
  - ./token-standard/splice-token-standard-test
  - ./splice-daml/splice-amulet-test
MPEOF

# Pin the SDK the vendored test packages target (derived, not hardcoded).
SDK="$(grep -m1 '^sdk-version:' deps/splice-daml/splice-amulet-test/daml.yaml | awk '{print $2}')"
echo "Installing SDK $SDK ..."
dpm install "$SDK"

# Alias the *-current.dar data-deps at the stable symlinks (same package-ids).
mkdir -p deps/splice-daml/splice-util/.daml/dist \
         deps/splice-daml/splice-amulet/.daml/dist \
         deps/splice-daml/splice-api-reward-assignment-v1/.daml/dist
ln -sf "$DARS/splice-util.dar" \
       deps/splice-daml/splice-util/.daml/dist/splice-util-current.dar
ln -sf "$DARS/splice-amulet.dar" \
       deps/splice-daml/splice-amulet/.daml/dist/splice-amulet-current.dar
ln -sf "$DARS/splice-api-reward-assignment-v1.dar" \
       deps/splice-daml/splice-api-reward-assignment-v1/.daml/dist/splice-api-reward-assignment-v1-current.dar

# Build the three source-only test packages bottom-up.
echo "==== building splice-token-test-trading-app ===="
( cd deps/token-standard/examples/splice-token-test-trading-app && dpm build )
# alias trading-app -current.dar (relative) so splice-token-standard-test resolves it
TTA="$(ls deps/token-standard/examples/splice-token-test-trading-app/.daml/dist/splice-token-test-trading-app-*.dar | head -1)"
ln -sf "$(basename "$TTA")" \
       deps/token-standard/examples/splice-token-test-trading-app/.daml/dist/splice-token-test-trading-app-current.dar

echo "==== building splice-token-standard-test ===="
( cd deps/token-standard/splice-token-standard-test && dpm build )
# alias ITS -current.dar (relative) so splice-amulet-test resolves it
TST="$(ls deps/token-standard/splice-token-standard-test/.daml/dist/splice-token-standard-test-*.dar | head -1)"
ln -sf "$(basename "$TST")" \
       deps/token-standard/splice-token-standard-test/.daml/dist/splice-token-standard-test-current.dar

echo "==== building splice-amulet-test ===="
( cd deps/splice-daml/splice-amulet-test && dpm build )

# Stable-name the harness output for splice-app-test/daml.yaml.
AT="$(ls deps/splice-daml/splice-amulet-test/.daml/dist/splice-amulet-test-*.dar | head -1)"
ln -sfn "$(basename "$AT")" \
        deps/splice-daml/splice-amulet-test/.daml/dist/splice-amulet-test.dar

echo ""
echo "Harness built: $(readlink deps/splice-daml/splice-amulet-test/.daml/dist/splice-amulet-test.dar)"
