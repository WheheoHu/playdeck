#!/usr/bin/env bash
set -euo pipefail

# Inside the Flatpak sandbox, Steam's per-app shader cache path on the host is read-only.
# Give Mesa and libplacebo a writable shader cache inside PlayDeck's sandbox cache.
export LD_LIBRARY_PATH="/app/lib:/app/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export MESA_SHADER_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/mesa_shader_cache"
mkdir -p "$MESA_SHADER_CACHE_DIR"

exec /app/lib/electron/electron --no-sandbox --ozone-platform=x11 /app/lib/playdeck "$@"
