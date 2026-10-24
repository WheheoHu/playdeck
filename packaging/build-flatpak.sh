#!/usr/bin/env bash
# Builds the self-contained PlayDeck Flatpak bundle (PlayDeck-x86_64.flatpak).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_ID="io.github.wheheohu.PlayDeck"
MANIFEST="$REPO_ROOT/packaging/$APP_ID.json"
BUILD_DIR="${FLATPAK_BUILD_DIR:-$REPO_ROOT/build-dir}"
STATE_DIR="${FLATPAK_STATE_DIR:-$REPO_ROOT/.flatpak-builder}"
REPO_DIR="${FLATPAK_REPO_DIR:-$REPO_ROOT/repo}"
OUT_BUNDLE="${1:-$REPO_ROOT/PlayDeck-x86_64.flatpak}"

if [[ "${SKIP_APP_BUILD:-0}" != "1" ]]; then
  npm --prefix "$REPO_ROOT/app" ci
  npm --prefix "$REPO_ROOT/app" run build
fi

STAGE_DIR="$REPO_ROOT/packaging/app-bundle"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -a "$REPO_ROOT/app/dist" "$REPO_ROOT/app/dist-electron" "$REPO_ROOT/app/mpv" "$REPO_ROOT/app/package.json" "$STAGE_DIR/"
trap 'rm -rf "$STAGE_DIR"' EXIT

if ! flatpak info --user org.freedesktop.Platform//25.08 >/dev/null 2>&1 || \
   ! flatpak info --user org.freedesktop.Sdk//25.08 >/dev/null 2>&1; then
  flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
  flatpak install --user -y --noninteractive flathub \
    org.freedesktop.Platform//25.08 \
    org.freedesktop.Sdk//25.08
fi

rm -rf "$REPO_DIR"
flatpak-builder \
  --user \
  --force-clean \
  --ccache \
  --disable-rofiles-fuse \
  --state-dir="$STATE_DIR" \
  --repo="$REPO_DIR" \
  "$BUILD_DIR" \
  "$MANIFEST"

flatpak build-bundle \
  "$REPO_DIR" \
  "$OUT_BUNDLE" \
  "$APP_ID"

(cd "$(dirname "$OUT_BUNDLE")" && sha256sum "$(basename "$OUT_BUNDLE")" > SHA256SUMS)
ls -lh "$OUT_BUNDLE" "$(dirname "$OUT_BUNDLE")/SHA256SUMS"
