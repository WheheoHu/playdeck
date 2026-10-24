#!/usr/bin/env bash
# Outputs PlayDeck's build version string: <Version>_<CommitSHA>_(Dev|Release)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ -n "${PLAYDECK_VERSION:-}" ]]; then
  BASE_VERSION="${PLAYDECK_VERSION#v}"
elif [[ "${GITHUB_REF_TYPE:-}" == "tag" && "${GITHUB_REF_NAME:-}" == v* ]]; then
  BASE_VERSION="${GITHUB_REF_NAME#v}"
else
  BASE_VERSION=$(node -p "require('$REPO_ROOT/app/package.json').version.replace(/-.*$/, '')")
fi

if [[ -n "${PLAYDECK_COMMIT:-}" ]]; then
  COMMIT_SHA="${PLAYDECK_COMMIT:0:7}"
elif git -C "$REPO_ROOT" rev-parse --short=7 HEAD >/dev/null 2>&1; then
  COMMIT_SHA=$(git -C "$REPO_ROOT" rev-parse --short=7 HEAD)
elif [[ -n "${GITHUB_SHA:-}" ]]; then
  COMMIT_SHA="${GITHUB_SHA:0:7}"
else
  COMMIT_SHA="unknown"
fi

if [[ -n "${PLAYDECK_CHANNEL:-}" ]]; then
  CHANNEL="$PLAYDECK_CHANNEL"
elif [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
  CHANNEL="Release"
else
  CHANNEL="Dev"
fi

echo "${BASE_VERSION}_${COMMIT_SHA}_${CHANNEL}"
