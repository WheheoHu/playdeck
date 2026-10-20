#!/usr/bin/env bash
# Entry point for the "PlayDeck (dev)" non-Steam shortcut on the Deck.
# Records the Gaming Mode environment, then runs whichever spike `current` points to.
set -u

DEV_ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
LOG_DIR="$DEV_ROOT/logs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
ln -sfn "$LOG_DIR" "$DEV_ROOT/logs/latest"

env | sort | grep -E '^(DISPLAY|WAYLAND_DISPLAY|GAMESCOPE_|STEAM_|SteamAppId|SteamGameId|ENABLE_|XDG_RUNTIME_DIR|XDG_SESSION|VK_|DXVK_HDR|SDL_)' > "$LOG_DIR/env.txt"
xprop -root 2>/dev/null | grep -E '^GAMESCOPE_' > "$LOG_DIR/gamescope-root.txt"
xdpyinfo 2>/dev/null | grep -E 'dimensions|resolution' > "$LOG_DIR/xdpyinfo.txt"

export PLAYDECK_DEV_ROOT="$DEV_ROOT"
export PLAYDECK_LOG_DIR="$LOG_DIR"
exec "$DEV_ROOT/current/launch.sh" > "$LOG_DIR/launch.log" 2>&1
