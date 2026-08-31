#!/usr/bin/env bash
#
# release-notes.sh - emit the GitHub release body for a canton-token-forge DAR.
#
# The consumer snippet is EXTRACTED from consumer-smoke/consumer/daml.yaml
# rather than written here. That package is compiled against the same DAR
# moments earlier in the release workflow, so the instructions published are
# the ones just proved to compile, and the two cannot drift apart.
#
# Usage:
#   bash scripts/release-notes.sh <tag>   # e.g. bash scripts/release-notes.sh v0.1.0
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Every field below is read out of a file, and both awk and grep report "found
# nothing" by producing no output rather than by failing. An unguarded read
# therefore publishes a release body with a blank where a version or a hash
# should be, which is worse than no release at all.
require() {
  local what="$1" value="$2"
  if [ -z "$value" ]; then
    echo "release-notes.sh: could not read $what" >&2
    exit 1
  fi
}

TAG="${1:?usage: release-notes.sh <tag>}"
SMOKE="consumer-smoke/consumer/daml.yaml"

# Read from daml.yaml rather than hardcoded here, which would go stale the
# moment the package version bumps and would report the wrong DAR name in a
# release body that otherwise describes the artifact just built.
VERSION="$(awk '/^version:/ {print $2; exit}' daml/canton-token-forge/daml.yaml)"
require "the package version from daml/canton-token-forge/daml.yaml" "$VERSION"
DAR="daml/canton-token-forge/.daml/dist/canton-token-forge-$VERSION.dar"
DAR_NAME="$(basename "$DAR")"

if [ ! -f "$DAR" ]; then
  echo "missing $DAR - run 'npm run build:canton-token-forge' first" >&2
  exit 1
fi

sha="$(sha256sum "$DAR" | cut -d' ' -f1)"
# The pipeline is allowed to fail here. A grep that matches nothing exits 1,
# and under pipefail that kills the script AT THE ASSIGNMENT, before anything
# can say what went wrong. Swallow the status and report on the value instead.
pkgid="$(unzip -l "$DAR" \
         | grep -oE "canton-token-forge-${VERSION//./\\.}-[0-9a-f]{64}" \
         | sort -u || true)"
require "the main package-id out of $DAR" "$pkgid"
splice_tag="$(awk -F= '/^SPLICE_TAG=/ {print $2; exit}' versions.env)"
require "SPLICE_TAG from versions.env" "$splice_tag"
sdk="$(awk '/^sdk-version:/ {print $2; exit}' daml/canton-token-forge/daml.yaml)"
require "the SDK pin from daml/canton-token-forge/daml.yaml" "$sdk"

# data-dependencies: and build-options: are the last two blocks of the smoke
# package's daml.yaml, so "from data-dependencies to end of file" is the whole
# snippet. Its comments are dropped: they explain the file to us, not the
# artifact to a consumer.
snippet="$(awk '/^data-dependencies:/,0' "$SMOKE" | grep -v '^[[:space:]]*#' || true)"
require "the consumer snippet out of $SMOKE" "$snippet"

cat <<EOF
\`$DAR_NAME\` is the whole dependency. It bundles the six
\`splice-api-token-*\` interface packages it links against, at the package-ids
it was compiled with, so a consumer does not vendor Splice, does not run our
setup, and does not need to match \`SPLICE_TAG\`.

## Consuming it

Download \`$DAR_NAME\` and save it as \`vendor/canton-token-forge.dar\`, then in your \`daml.yaml\`:

\`\`\`yaml
$snippet
\`\`\`

The \`--package\` lines are required. The bundled interface packages are hidden
by default, and importing \`Splice.Api.Token.*\` without them fails with
"member of the hidden package".

## Requirements

| | |
|---|---|
| Daml SDK | $sdk |
| LF target | 2.1 |
| Built against Splice | $splice_tag |

## Verifying this asset

The DAR is byte-reproducible from a clean tree, so you can rebuild it at
\`$TAG\` and compare rather than trust it.

\`\`\`
sha256      $sha
package-id  $pkgid
\`\`\`

## Not included

\`splice-api-token-allocation-request-v1\` is declared by this package but never
implemented, so it is not bundled. A consumer needing \`AllocationRequest\` takes
it from Splice directly.
EOF
