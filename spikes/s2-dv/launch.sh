#!/usr/bin/env bash
# S2: Dolby Vision RPU handling under VA-API hardware decoding, plus a 5-minute 4K24 drop test
# (docs/DESIGN.md, section 14).
set -u

SPIKE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
set -a
. "$PLAYDECK_DEV_ROOT/secrets/plex.env"
set +a

export PYTHONPATH="$PLAYDECK_DEV_ROOT/lib"
exec python3 "$SPIKE_DIR/driver.py"
