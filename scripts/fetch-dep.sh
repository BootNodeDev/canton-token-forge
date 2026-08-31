#!/bin/bash
# Vendor the upstream canton-network/splice sources this project builds against,
# then derive each DAR's version from the vendored source tree and expose it via
# a stable-name symlink so daml.yaml never has to name a version.
#
# Single knob: SPLICE_TAG in versions.env. Bump it, re-run, everything follows.
set -euo pipefail
export LANG="${LANG:-C.UTF-8}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source versions.env   # provides SPLICE_TAG

REPO="https://github.com/canton-network/splice.git"
DARS="deps/splice-daml/dars"

# Both fetch paths retry. This is the only network step in the setup and it has
# nothing to resume from, so on a cold CI cache a single DNS or 5xx blip is
# worth a second attempt rather than a failed run. A third is not: the failure
# that is not a blip is a transport that stays broken for as long as that
# environment does, and every attempt pays for it with a full transfer before
# the tarball fallback below is even reached.
retry() {
  local attempt max=2
  for ((attempt = 1; attempt <= max; attempt++)); do
    if "$@"; then return 0; fi
    echo "attempt ${attempt} of ${max} failed: $*" >&2
    if [ "$attempt" -lt "$max" ]; then sleep 5; fi
  done
  return 1
}

# --filter=blob:none defers the blobs to the sparse-checkout, so both halves
# touch the network and the retry has to cover them together, from a clean dir.
sparse_clone() {
  rm -rf .tmp-splice
  git clone --filter=blob:none --sparse --depth=1 --branch "$SPLICE_TAG" "$REPO" .tmp-splice \
    && ( cd .tmp-splice && git sparse-checkout set daml token-standard )
}

echo "Fetching daml/ + token-standard/ from canton-network/splice@${SPLICE_TAG}..."
splice_commit=""
if retry sparse_clone; then
  # Read out of the clone rather than resolved over the network: this is the
  # commit whose tree is about to be vendored, which is the fact worth keeping.
  splice_commit="$(git -C .tmp-splice rev-parse HEAD)"
else
  # Fallback for environments where git's smart-HTTP pack transfer is broken
  # (e.g. a corrupting MITM proxy): fetch the same tag as a tarball instead.
  echo "git sparse-clone failed; falling back to tarball fetch..." >&2
  rm -rf .tmp-splice
  mkdir -p .tmp-splice
  # To a file rather than into tar's stdin: a retried transfer restarts from
  # the top, and the pipe has already swallowed the bytes of the attempt that
  # failed.
  curl -fsSL --retry 3 --retry-all-errors --retry-delay 5 \
    "https://codeload.github.com/canton-network/splice/tar.gz/refs/tags/${SPLICE_TAG}" \
    --output .tmp-splice/source.tar.gz
  tar -xzf .tmp-splice/source.tar.gz -C .tmp-splice --strip-components=1 \
      "splice-${SPLICE_TAG}/daml" "splice-${SPLICE_TAG}/token-standard"
  # A tarball carries no commit, so this path asks the remote what the tag
  # names. codeload served that same tag moments ago, so the two agree unless
  # the tag moved in between, which is the case the stamp exists to expose.
  #
  # The status is swallowed deliberately. This path is reached because git's
  # transport to that host is broken, so ls-remote is the call most likely to
  # fail here, and under pipefail a failing one kills the script AT THIS
  # ASSIGNMENT, before the check below can name the tag it could not resolve.
  splice_commit="$(git ls-remote "$REPO" "refs/tags/${SPLICE_TAG}^{}" "refs/tags/${SPLICE_TAG}" \
                   | tail -n1 | cut -f1 || true)"
fi

# Vendor: daml/ -> deps/splice-daml ; token-standard/ -> deps/token-standard (siblings).
rm -rf deps/splice-daml && mkdir -p deps/splice-daml && cp -r .tmp-splice/daml/. deps/splice-daml
rm -rf deps/token-standard && mkdir -p deps/token-standard && cp -r .tmp-splice/token-standard/. deps/token-standard
rm -rf .tmp-splice

# A git tag can be re-pointed upstream, so SPLICE_TAG alone does not identify
# what a build consumed. The release body tells a consumer to rebuild the DAR
# and compare hashes, which only means something if they can vendor the same
# source; this records what this run actually vendored so the body can name it.
# It lives beside the tree it describes, and is rewritten whenever that tree is.
if [ -z "$splice_commit" ]; then
  echo "could not resolve the commit for ${SPLICE_TAG}" >&2
  exit 1
fi
echo "$splice_commit" > deps/.splice-commit
echo "Vendored canton-network/splice@${SPLICE_TAG} (${splice_commit})"

# The upstream token-standard packages reference ../../daml/...; splice-amulet-test
# references ../../token-standard/... . We vendored daml/ AS splice-daml/, so this
# symlink makes both path shapes resolve.
ln -sfn splice-daml deps/daml

# --- Derive each version from the vendored source daml.yaml, then stable-symlink ---
read_ver() { grep -m1 '^version:' "$1" | awk '{print $2}'; }

# link_stable <package-name> <path-to-source-daml.yaml>
# creates deps/splice-daml/dars/<pkg>.dar -> <pkg>-<derived-version>.dar
link_stable() {
  local pkg="$1" src="$2" ver
  ver="$(read_ver "$src")"
  if [ -z "$ver" ]; then echo "ERROR: could not derive version for $pkg from $src" >&2; exit 1; fi
  if [ ! -f "$DARS/$pkg-$ver.dar" ]; then
    echo "ERROR: expected DAR $DARS/$pkg-$ver.dar not found (tag $SPLICE_TAG)" >&2; exit 1
  fi
  ln -sfn "$pkg-$ver.dar" "$DARS/$pkg.dar"
  echo "  $pkg -> $pkg-$ver.dar"
}

echo "Deriving versions + creating stable-name symlinks:"
link_stable splice-amulet                            deps/splice-daml/splice-amulet/daml.yaml
link_stable splice-util                              deps/splice-daml/splice-util/daml.yaml
link_stable splice-api-reward-assignment-v1          deps/splice-daml/splice-api-reward-assignment-v1/daml.yaml
link_stable splice-api-featured-app-v1               deps/splice-daml/splice-api-featured-app-v1/daml.yaml
link_stable splice-api-token-holding-v1              deps/token-standard/splice-api-token-holding-v1/daml.yaml
link_stable splice-api-token-metadata-v1             deps/token-standard/splice-api-token-metadata-v1/daml.yaml
link_stable splice-api-token-transfer-instruction-v1 deps/token-standard/splice-api-token-transfer-instruction-v1/daml.yaml
link_stable splice-api-token-allocation-v1             deps/token-standard/splice-api-token-allocation-v1/daml.yaml
link_stable splice-api-token-allocation-instruction-v1 deps/token-standard/splice-api-token-allocation-instruction-v1/daml.yaml
link_stable splice-api-token-allocation-request-v1     deps/token-standard/splice-api-token-allocation-request-v1/daml.yaml
# burn-mint SOURCE lives under deps/splice-daml (the token-standard/ copy is docs-only);
# the compiled DAR is still in deps/splice-daml/dars/, so the symlink resolves.
link_stable splice-api-token-burn-mint-v1              deps/splice-daml/splice-api-token-burn-mint-v1/daml.yaml

echo "Done. Vendored deps + stable symlinks ready under deps/."
