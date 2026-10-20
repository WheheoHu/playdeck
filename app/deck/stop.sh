#!/usr/bin/env bash
# Stops any development build running from ~/playdeck-dev/vendor. Matches on the executable, because
# Chromium rewrites its command line and pkill -f no longer sees the original path.
vendor="$HOME/playdeck-dev/vendor/"
for proc in /proc/[0-9]*; do
  exe=$(readlink "$proc/exe" 2>/dev/null) || continue
  [[ "$exe" == "$vendor"* ]] && kill "${proc#/proc/}" 2>/dev/null
done
for _ in 1 2 3 4 5 6 7 8 9 10; do
  running=0
  for proc in /proc/[0-9]*; do
    exe=$(readlink "$proc/exe" 2>/dev/null) || continue
    [[ "$exe" == "$vendor"* ]] && running=1 && break
  done
  ((running)) || exit 0
  sleep 0.5
done
