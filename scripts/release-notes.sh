#!/usr/bin/env bash
#
# release-notes.sh - emit the GitHub release body for a canton-token-forge DAR.
#
# The consumer snippet is EXTRACTED from consumer-smoke/consumer/daml.yaml
# rather than written here, so what gets published is what a package really
# builds with and the two cannot drift apart. Compiling that package is what
# proves the snippet, and this script does not compile it: run
# `npm run smoke` before publishing a release.
#
# Usage:
#   bash scripts/release-notes.sh <tag>              # build, then emit the body
#   SKIP_BUILD=1 bash scripts/release-notes.sh <tag> # emit for the built DAR
#
# Env overrides:
#   SKIP_BUILD        set to 1 to skip the dpm build step
#   ALLOW_UNTAGGED    set to 1 to emit a preview body before <tag> exists
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

# A block whose entries are gone still yields its header line, so requiring a
# non-empty value passes and the body publishes "data-dependencies:" with
# nothing under it. The snippet is only worth publishing if it names something.
require_entries() {
  local what="$1" block="$2"
  require "$what" "$block"
  if ! printf '%s\n' "$block" | grep -q '^[[:space:]]*-[[:space:]]'; then
    echo "release-notes.sh: $what has no entries" >&2
    exit 1
  fi
}

# One top-level block of a daml.yaml: its header line plus every line up to the
# next top-level key. Reading the two blocks BY NAME, rather than everything
# from data-dependencies to end of file, is what keeps the published snippet
# right no matter where in that file the blocks sit or what is added after
# them. The old range silently published an empty snippet when they were
# reordered, and swallowed any block appended below them.
yaml_block() {
  awk -v key="$2" '
    $0 ~ "^" key ":[[:space:]]*$" { inblock = 1; print; next }
    inblock && /^[A-Za-z][A-Za-z0-9_-]*:/ { inblock = 0 }
    inblock { print }
  ' "$1"
}

TAG="${1:?usage: release-notes.sh <tag>}"
SMOKE="consumer-smoke/consumer/daml.yaml"

# The body invites a consumer to rebuild the DAR at $TAG and compare hashes,
# and $TAG is otherwise just a string this script prints. Checked before the
# build because a failure here invalidates everything the build would produce.
#
# A tag that exists but names another commit is always a refusal: whichever of
# the two is wrong, the pair we would publish is. Only the not-yet-tagged case
# has an override, for previewing a body while preparing a release.
#
# Resolved under refs/tags/ rather than as a bare commit-ish, which would also
# accept a branch, HEAD or an abbreviated sha. A release body tells a consumer
# to rebuild at this name forever, so a name that moves with the next commit,
# or means nothing outside this checkout, is not one we can publish.
tagged="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}" || true)"
if [ -z "$tagged" ]; then
  if [ "${ALLOW_UNTAGGED:-0}" != "1" ]; then
    echo "release-notes.sh: $TAG is not a tag in this repository" >&2
    echo "  (set ALLOW_UNTAGGED=1 to emit a preview body)" >&2
    exit 1
  fi
elif [ "$tagged" != "$(git rev-parse HEAD)" ]; then
  echo "release-notes.sh: $TAG is $tagged, not the checked-out commit" >&2
  exit 1
fi

# Untracked files count: an untracked .daml source under daml/ is compiled into
# the DAR and exists at no commit, which is the same irreproducible hash as an
# uncommitted edit. Build output and deps are gitignored, so neither shows here.
#
# Checked on the status rather than on the output alone: a git that cannot read
# the tree (a held index.lock, a refused ownership check) prints nothing, and
# testing only for emptiness reads that silence as "clean" and publishes the
# very hash this guard exists to withhold.
if ! tree_state="$(git status --porcelain)"; then
  echo "release-notes.sh: git could not report the working tree state" >&2
  exit 1
fi
if [ -n "$tree_state" ]; then
  echo "release-notes.sh: the working tree is dirty, so the sha256 below" >&2
  echo "  would not be reproducible from $TAG" >&2
  exit 1
fi

# Building by default is what keeps the body honest: the sha256 and package-id
# below describe whatever DAR is on disk, and a stale one publishes an artifact
# that no longer matches the source at this tag, which is exactly the
# comparison the "rebuild and compare" section invites. Build output goes to
# stderr because stdout is the release body.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm run build:canton-token-forge >&2
fi

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

# GNU coreutils on the CI runner, BSD tooling on a maintainer's macOS. Both
# print "<hash>  <file>", so only the command name differs.
if command -v sha256sum >/dev/null 2>&1; then
  sha="$(sha256sum "$DAR" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  sha="$(shasum -a 256 "$DAR" | cut -d' ' -f1)"
else
  echo "release-notes.sh: no sha256sum or shasum on PATH" >&2
  exit 1
fi
require "the sha256 of $DAR" "$sha"

# Named here rather than left to fail inside the pipeline below, where the
# `|| true` swallows the status and the reader is told the package-id could
# not be read out of the DAR, which blames the artifact for a missing tool.
if ! command -v unzip >/dev/null 2>&1; then
  echo "release-notes.sh: no unzip on PATH, needed to read the package-id" >&2
  exit 1
fi

DAR_LISTING="$(unzip -l "$DAR" || true)"
require "the contents of $DAR" "$DAR_LISTING"

# The pipeline is allowed to fail here. A grep that matches nothing exits 1,
# and under pipefail that kills the script AT THE ASSIGNMENT, before anything
# can say what went wrong. Swallow the status and report on the value instead.
pkgid="$(printf '%s\n' "$DAR_LISTING" \
         | grep -oE "canton-token-forge-${VERSION//./\\.}-[0-9a-f]{64}" \
         | sort -u || true)"
require "the main package-id out of $DAR" "$pkgid"
# One line, not merely non-empty. sort -u collapses the repeated matches a
# single dalf produces, but two dalfs of this package at different package-ids
# survive it as two lines, and the strip below reads to the last '-' in the
# whole value, so it returns the second one and the body publishes that as
# the main package-id, with no diagnostic, in the section whose purpose is
# letting a consumer verify the asset.
if [ "$(wc -l <<< "$pkgid" | tr -d ' ')" != 1 ]; then
  echo "release-notes.sh: $DAR_NAME carries more than one package-id for" \
       "canton-token-forge-$VERSION" >&2
  exit 1
fi
# The dalf is named <package>-<version>-<package-id>, and matching that whole
# name is what picks the MAIN package out of the bundled ones. Only the
# trailing hash is the package-id itself: it is what `damlc inspect-dar --json`
# reports as main_package_id and what a template id carries, so publishing the
# prefixed form fails a consumer's literal comparison against an identical DAR.
pkgid="${pkgid##*-}"
splice_tag="$(awk -F= '/^SPLICE_TAG=/ {print $2; exit}' versions.env)"
require "SPLICE_TAG from versions.env" "$splice_tag"
# The tag names what we asked for; this names what was vendored. A tag can be
# re-pointed upstream, and then a consumer following "rebuild it and compare"
# builds against different source and gets a hash that will never match, with
# nothing in the body to tell them which of the two moved. Written by
# scripts/fetch-dep.sh beside the tree it describes, so an absent stamp means
# deps/ predates that script and the body would be describing an unknown input.
stamped_tag="$(awk -F= '/^SPLICE_TAG=/ {print $2; exit}' deps/.splice-commit 2>/dev/null || true)"
require "the vendored Splice tag from deps/.splice-commit (run 'npm run setup')" "$stamped_tag"
splice_commit="$(awk -F= '/^SPLICE_COMMIT=/ {print $2; exit}' deps/.splice-commit 2>/dev/null || true)"
require "the vendored Splice commit from deps/.splice-commit (run 'npm run setup')" "$splice_commit"
# Absence is not the only way the stamp fails to describe deps/. Editing
# SPLICE_TAG and not re-running the vendor step leaves a tree that answers to
# the old tag while versions.env, and so the row above, names the new one. The
# body would then pair a tag with a commit that tag does not name, and a
# consumer who follows the tag row vendors source this DAR was not built
# from, so the hash below is one they cannot reach.
if [ "$stamped_tag" != "$splice_tag" ]; then
  echo "release-notes.sh: versions.env asks for Splice $splice_tag," \
       "but deps/ was vendored from $stamped_tag" >&2
  echo "  (run 'npm run setup' to re-vendor)" >&2
  exit 1
fi
sdk="$(awk '/^sdk-version:/ {print $2; exit}' daml/canton-token-forge/daml.yaml)"
require "the SDK pin from daml/canton-token-forge/daml.yaml" "$sdk"

# Comments are dropped: they explain that file to us, not the artifact to a
# consumer.
deps_block="$(yaml_block "$SMOKE" data-dependencies | grep -v '^[[:space:]]*#' || true)"
require_entries "the data-dependencies block of $SMOKE" "$deps_block"
opts_block="$(yaml_block "$SMOKE" build-options | grep -v '^[[:space:]]*#' || true)"
require_entries "the build-options block of $SMOKE" "$opts_block"
snippet="$deps_block
$opts_block"

# The snippet is only correct for the DAR it is published beside, and nothing
# else in this repo ties the two together: the forge reaches its dependencies
# through version-free symlinks, so a SPLICE_TAG bump that ships a new
# interface version builds green while these flags still name the old one.
# Compiling the smoke package is what would catch that, and this script does
# not compile, so check the names against the archive itself. Every bundled
# package is filed as <dir>/<unit-id>-<package-id>.dalf.
packages="$(printf '%s\n' "$opts_block" \
            | sed -n 's/^[[:space:]]*-[[:space:]]*--package=//p')"
# Without these the imports fail on "member of the hidden package", so a
# snippet that has lost them is broken in the one way this package exists to
# prevent. An emptied block is caught above; this catches a block that kept
# --target and nothing else.
require "any --package flag in the build-options block of $SMOKE" "$packages"
while IFS= read -r unit; do
  if ! printf '%s\n' "$DAR_LISTING" \
       | grep -qE "/${unit//./\\.}-[0-9a-f]{64}\.dalf"; then
    echo "release-notes.sh: $SMOKE names --package=$unit," \
         "which $DAR_NAME does not bundle" >&2
    exit 1
  fi
done <<< "$packages"

# The loop above is one-directional: it catches a flag naming something the DAR
# does not bundle, but not a bundled package the snippet has stopped naming.
# That is the same broken consumer build, and it is the quieter of the two,
# because every flag that remains is still valid. Derived from the archive so
# it tracks whatever interface set the DAR actually carries.
bundled="$(printf '%s\n' "$DAR_LISTING" \
           | sed -nE 's#.*/(splice-api-token-.*)-[0-9a-f]{64}\.dalf#\1#p' \
           | sort -u)"
require "the bundled splice-api-token packages of $DAR_NAME" "$bundled"
while IFS= read -r unit; do
  if ! grep -qxF "$unit" <<< "$packages"; then
    echo "release-notes.sh: $DAR_NAME bundles $unit, which $SMOKE" \
         "does not name with a --package flag" >&2
    exit 1
  fi
done <<< "$bundled"

# Three values below appear in prose as well as in the snippet, and a literal
# copy of any of them goes stale silently: the count when the interface set
# changes, the LF target when an SDK bump moves it, the vendor path when the
# smoke package renames what it depends on. The last two are read from the same
# file the snippet is cut from, so the prose and the yaml cannot disagree.
#
# The count is taken from the archive rather than from the flags, because the
# prose says how many interface packages the DAR bundles and the flag list is
# not that number. Nothing deduplicates or filters it, so a repeated flag, or
# one naming a bundled package that is not an interface, inflates the count
# while both checks above still pass: each names something bundled, and every
# bundled interface is still named. $bundled is sorted, unique and already
# restricted to splice-api-token-*, so it is the set the sentence describes.
# wc, not grep -c: grep exits 1 on no match, which under set -e would kill the
# script at the assignment and leave the guard below unreachable. $bundled is
# already known non-empty here, so this only has to count it honestly.
pkg_count="$(wc -l <<< "$bundled" | tr -d ' ')"
lf_target="$(sed -n 's/^[[:space:]]*-[[:space:]]*--target=//p' <<< "$opts_block")"
require "the LF target from the build-options block of $SMOKE" "$lf_target"
# One line, not merely non-empty. The sed above collects every --target
# entry, and a second one reaches the Requirements table as a cell broken
# across two rows naming two different targets, which is neither readable nor
# true. Both workflows now refuse such a manifest; this is the copy that runs
# on a maintainer's machine, where neither has looked at it yet.
if [ "$(wc -l <<< "$lf_target" | tr -d ' ')" != 1 ]; then
  echo "release-notes.sh: $SMOKE names more than one --target entry" >&2
  exit 1
fi
vendor_path="$(sed -n 's/^[[:space:]]*-[[:space:]]*//p' <<< "$deps_block" | head -1)"
require "the data-dependency path from $SMOKE" "$vendor_path"

# The "Not included" section below names this package as absent, which is a
# claim about the archive and not about our source. If it ever ships bundled
# the section becomes a lie that sends a consumer to Splice for something they
# already have, so it is checked rather than asserted.
ABSENT="splice-api-token-allocation-request-v1"
if grep -q "^$ABSENT-" <<< "$bundled"; then
  echo "release-notes.sh: $DAR_NAME bundles $ABSENT," \
       "which this script's \"Not included\" section says it does not" >&2
  exit 1
fi

cat <<EOF
\`$DAR_NAME\` is the whole dependency. It bundles all $pkg_count
\`splice-api-token-*\` interface packages it links against, at the package-ids
it was compiled with, so a consumer does not vendor Splice, does not run our
setup, and does not need to match \`SPLICE_TAG\`.

## Consuming it

Download \`$DAR_NAME\` and save it as \`$vendor_path\`, then in your \`daml.yaml\`:

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
| LF target | $lf_target |
| Built against Splice | $splice_tag |
| Splice commit | $splice_commit |

## Verifying this asset

The DAR is byte-reproducible from a clean tree, so you can rebuild it at
\`$TAG\` and compare rather than trust it.

\`\`\`
sha256      $sha
package-id  $pkgid
\`\`\`

## Not included

\`$ABSENT\` is declared by this package but never
implemented, so it is not bundled. A consumer needing \`AllocationRequest\` takes
it from Splice directly.
EOF
