#!/usr/bin/env bash
# Runs S1 and then S2 in one Gaming Mode session, sharing a log directory.
set -u

"$PLAYDECK_DEV_ROOT/s1-handoff/launch.sh"
exec "$PLAYDECK_DEV_ROOT/s2-dv/launch.sh"
