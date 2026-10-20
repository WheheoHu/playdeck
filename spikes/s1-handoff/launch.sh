#!/usr/bin/env bash
# S1: an Electron window hands off to full-screen HDR mpv and back, repeatedly (docs/DESIGN.md, section 14).
set -u

SPIKE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
set -a
. "$PLAYDECK_DEV_ROOT/secrets/plex.env"
set +a

# 4K Dolby Vision 8.1 + HDR10+ sample part key on the test server.
export S1_PART_KEY="${S1_PART_KEY:-/library/parts/1/1/file.mkv}"

exec "$PLAYDECK_DEV_ROOT/vendor/electron/electron" --no-sandbox --ozone-platform=x11 "$SPIKE_DIR"
