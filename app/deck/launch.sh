#!/usr/bin/env bash
# PlayDeck development build on the Deck, started by the "PlayDeck (dev)" shortcut via ~/playdeck-dev/current.
set -u

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
mkdir -p "$PLAYDECK_DEV_ROOT/run"
export PLAYDECK_DEV_CONTROL="$PLAYDECK_DEV_ROOT/run/app-control.sock"

exec "$PLAYDECK_DEV_ROOT/vendor/electron/electron" --no-sandbox --ozone-platform=x11 "$APP_DIR"
