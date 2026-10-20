#!/usr/bin/env bash
# S5: browse UI frame-rate budget on the internal panel (docs/DESIGN.md, sections 8.1 and 14).
set -u

SPIKE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
set -a
. "$PLAYDECK_DEV_ROOT/secrets/plex.env"
set +a

PYTHONPATH="$PLAYDECK_DEV_ROOT/lib" python3 "$SPIKE_DIR/present_sampler.py" "$PLAYDECK_LOG_DIR/s5-presents.txt" &
sampler=$!
trap 'kill "$sampler" 2>/dev/null' EXIT

"$PLAYDECK_DEV_ROOT/vendor/electron/electron" --no-sandbox --ozone-platform=x11 ${S5_CHROMIUM_FLAGS:-} "$SPIKE_DIR"
