#!/usr/bin/env bash
# Builds PlayDeck, copies it to the Deck and points the "PlayDeck (dev)" shortcut at it
# (docs/DESIGN.md, section 12). With --launch, also starts it in Gaming Mode.
set -euo pipefail

cd "$(dirname "$0")/.."
# One-off target from the operator. The default host lives in their SSH config, never in the repo.
host="${PLAYDECK_DECK_HOST:-steamdeck}"
npm run build
rsync -a --delete --exclude '*.map' dist dist-electron mpv package.json "${host}:playdeck-dev/app/"
rsync -a deck/ "${host}:playdeck-dev/app/"
ssh "$host" 'chmod +x ~/playdeck-dev/app/*.sh ~/playdeck-dev/app/devctl.py && ln -sfn app ~/playdeck-dev/current'

if [[ "${1:-}" == "--launch" ]]; then
  # run.sh records the shortcut's game id on every launch.
  game_id=$(ssh "$host" "sed -n 's/^SteamGameId=//p' ~/playdeck-dev/logs/latest/env.txt")
  ssh "$host" "~/playdeck-dev/app/stop.sh; sleep 1; steam steam://rungameid/$game_id >/dev/null 2>&1"
fi
