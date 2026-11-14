#!/usr/bin/env bash
# Ships what's on main: checks, smoke test, next tag, push the tag, deploy it.
# Run on the laptop after merging to main.
#   scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "release: $*" >&2; exit 1; }

[[ "$(git branch --show-current)" == main ]] || fail "check out main first"
[[ -z "$(git status --porcelain)" ]] || fail "uncommitted changes; commit or stash them"
git fetch --quiet --tags origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
  || fail "main is not the same as origin/main; pull or push first"
if tag=$(git describe --tags --exact-match HEAD 2>/dev/null); then
  fail "HEAD is already tagged $tag; deploy it with scripts/deploy.sh $tag"
fi

./scripts/smoke-test.sh

last=$(git tag --list 'v*' --sort=-v:refname | head -n1)
last="${last:-v0.0.0}"
IFS=. read -r major minor patch <<<"${last#v}"
echo
echo "Last release: $last. Changes since then:"
git log --oneline "${last}..HEAD" 2>/dev/null || git log --oneline
echo
read -r -p "Bump patch, minor or major? [patch] " bump
case "${bump:-patch}" in
  patch) patch=$((patch + 1)) ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  major) major=$((major + 1)); minor=0; patch=0 ;;
  *) fail "answer patch, minor or major" ;;
esac
next="v$major.$minor.$patch"
read -r -p "Tag $(git rev-parse --short HEAD) as $next, push it and deploy? [y/N] " ok
[[ "$ok" =~ ^[Yy] ]] || fail "stopped; nothing tagged"

git tag -a "$next" -m "$next"
git push --quiet origin "$next"
echo "release: pushed $next"
./scripts/deploy.sh "$next"
