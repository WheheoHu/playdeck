#!/usr/bin/env bash
# S4: can PlayDeck switch the internal panel's refresh rate through GAMESCOPE_DYNAMIC_REFRESH,
# and does Steam leave the value alone during playback? (docs/DESIGN.md, section 14)
set -u

SPIKE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
set -a
. "$PLAYDECK_DEV_ROOT/secrets/plex.env"
set +a

export PYTHONPATH="$PLAYDECK_DEV_ROOT/lib"
exec python3 "$SPIKE_DIR/driver.py"
