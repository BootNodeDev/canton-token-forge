#!/usr/bin/env bash
# One-shot project initializer. Renames the generic `splice-app` package to your
# project name, optionally sets the Splice tag, then deletes itself.
#
#   ./init.sh <project-name>      # lowercase-kebab, e.g. my-token
#
# Renames the PACKAGE (folders, daml.yaml names, multi-package.yaml, package.json).
# The sample Daml MODULES stay named SpliceApp / SpliceApp.Tests.SmokeTest -
# replace them when you write real contracts.
set -euo pipefail

OLD="splice-app"
NEW="${1:-}"
if [ -z "$NEW" ]; then
  echo "usage: ./init.sh <project-name>   (lowercase-kebab, e.g. my-token)" >&2; exit 1
fi
if ! printf '%s' "$NEW" | grep -qE '^[a-z][a-z0-9-]*$'; then
  echo "ERROR: name must be lowercase-kebab matching ^[a-z][a-z0-9-]*$" >&2; exit 1
fi
if [ "$NEW" = "$OLD" ]; then
  echo "Nothing to do: name already '$OLD'." >&2; exit 0
fi

# 1. Splice tag (single knob), default = current value in versions.env
CUR_TAG="$(grep -m1 '^SPLICE_TAG=' versions.env | cut -d= -f2)"
read -rp "Splice tag [$CUR_TAG]: " TAG
TAG="${TAG:-$CUR_TAG}"
sed -i.bak "s/^SPLICE_TAG=.*/SPLICE_TAG=$TAG/" versions.env && rm -f versions.env.bak

# 2. rename package folders (git mv when tracked, else plain mv)
mv_dir() { git mv "$1" "$2" 2>/dev/null || mv "$1" "$2"; }
mv_dir "daml/$OLD-test" "daml/$NEW-test"
mv_dir "daml/$OLD"      "daml/$NEW"

# 3. text replacements in tracked config files (NOT deps/, NOT .daml/).
#    Replace the "-test" suffix form FIRST so the bare form can't clobber it.
FILES="multi-package.yaml package.json package-lock.json daml/$NEW/daml.yaml daml/$NEW-test/daml.yaml"
for f in $FILES; do
  sed -i.bak "s/${OLD}-test/${NEW}-test/g; s/${OLD}/${NEW}/g" "$f" && rm -f "$f.bak"
done

# 4. self-delete
git rm -f init.sh 2>/dev/null || rm -f init.sh

echo ""
echo "Renamed splice-app -> $NEW (Splice tag: $TAG)."
echo "Next:"
echo "  npm install    # vendor deps + build the harness"
echo "  npm test       # build + run the smoke test"
