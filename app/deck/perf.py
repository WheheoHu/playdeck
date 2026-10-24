#!/usr/bin/env python3
"""Browse-UI performance regression test on the Deck (docs/DESIGN.md, sections 8.1 and 14).

Run while a fresh PlayDeck dev build shows Home in Gaming Mode. Drives scripted navigation through the
control socket and judges two measures against the panel's refresh period:
  - requestAnimationFrame intervals in the page;
  - gamescope's own present intervals while animations run (first present after each key skipped).
"""

import bisect
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

DEV_ROOT = Path.home() / "playdeck-dev"
sys.path.insert(0, str(DEV_ROOT / "lib"))
from gamescope_control import GamescopeControl  # noqa: E402

SOCKET = os.environ.get("PLAYDECK_DEV_CONTROL", str(DEV_ROOT / "run" / "app-control.sock"))
FOCUS_ANIMATION_MS = 140
PAGE_ANIMATION_MS = 200
SAME_PRESENT_NS = 2_000_000

# (phase, keys, interval ms). 90 ms is the gamepad's key repeat (src/ui/input.ts), so held D-pad
# scrolling overlaps animations the way a user's does. Expects the Libraries tab to list movie and TV
# sections, and the show section to open on a show with several seasons.
SCRIPT = [
    ("home-rows", ["Right"] * 12, 90),
    ("home-rows", ["Down"], 400),
    ("home-rows", ["Right"] * 12, 90),
    ("home-rows", ["Left"] * 12, 120),
    ("home-rows", ["Down"], 400),
    ("home-rows", ["Right"] * 12, 90),
    ("home-rows", ["Up", "Up"], 300),
    ("libraries", ["]"], 1500),
    ("libraries", ["Right", "Right", "Left", "Down", "Up"], 250),
    ("libraries", ["Return"], 3000),
    ("grid", ["Down"] * 10, 90),
    ("grid", ["Right"] * 3, 120),
    ("grid", ["PageDown"] * 2, 600),
    ("grid", ["Up"] * 14, 90),
    ("grid", ["Escape"], 800),
    ("show", ["Right", "Right"], 300),
    ("show", ["Return"], 3000),
    ("show", ["Return"], 3000),
    ("show", ["Right"] * 8, 90),
    ("show", ["Left"] * 8, 120),
    ("show", ["Up", "Right"], 300),
    ("show", ["Return"], 2000),
    ("show", ["Down"], 400),
    ("show", ["Right"] * 6, 90),
    ("back-home", ["Escape", "Escape"], 800),
    ("back-home", ["["], 1500),
    ("back-home", ["Right"] * 8, 120),
]


def control(payload):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(SOCKET)
        sock.sendall((json.dumps(payload) + "\n").encode())
        reply = json.loads(sock.makefile().readline())
    if not reply["ok"]:
        raise RuntimeError(reply["error"])
    return reply.get("result")


def refresh_hz():
    out = subprocess.run(["xrandr", "--display", ":1", "--current"], capture_output=True, text=True).stdout
    match = re.search(r"(\d+\.\d+)\*", out)
    return float(match.group(1)) if match else 90.0


def app_id():
    env = (DEV_ROOT / "logs" / "latest" / "env.txt").read_text()
    return int(re.search(r"^SteamAppId=(\d+)$", env, re.M).group(1))


class PresentSampler(threading.Thread):
    def __init__(self, app):
        super().__init__(daemon=True)
        self.app = app
        self.samples = []
        self.running = True

    def run(self):
        gamescope = GamescopeControl()
        gamescope.request_frametime(self.app)
        while self.running:
            try:
                frametime = gamescope.wait_frametime_ns(timeout=0.5)
            except socket.timeout:
                continue
            at = time.monotonic_ns()
            gamescope.request_frametime(self.app)
            if not self.samples or at - self.samples[-1][0] >= SAME_PRESENT_NS:
                self.samples.append((at, frametime))
        gamescope.close()


def percentile(values, p):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * p))] if ordered else 0.0


def judge(intervals_ms, period_ms):
    drops = sum(1 for interval in intervals_ms if interval > 1.5 * period_ms)
    p95 = percentile(intervals_ms, 0.95)
    return {
        "samples": len(intervals_ms),
        "median_ms": round(percentile(intervals_ms, 0.5), 2),
        "p95_ms": round(p95, 2),
        "max_ms": round(max(intervals_ms, default=0), 2),
        "drops": drops,
        "drop_ratio": round(drops / len(intervals_ms), 4) if intervals_ms else 0,
        "pass": bool(intervals_ms) and p95 <= period_ms * 1.05 and drops / len(intervals_ms) <= 0.01,
    }


def main():
    hz = refresh_hz()
    period_ms = 1000 / hz
    if "--cold" in sys.argv:
        # Every poster and still is fetched and decoded during the run, as on a first visit.
        control({"cmd": "clear-cache"})
    sampler = PresentSampler(app_id())
    sampler.start()
    time.sleep(0.5)

    control({"cmd": "perf-start"})
    keys = []
    for phase, names, interval in SCRIPT:
        sent = control({"cmd": "keys", "keys": names, "intervalMs": interval})
        keys += [(phase, name, int(key["at"]), key["moved"]) for name, key in zip(names, sent)]
    raf = control({"cmd": "perf-stop"})
    sampler.running = False
    sampler.join()

    presents = sampler.samples
    times = [at for at, _ in presents]
    phases = {}
    for phase, name, at, moved in keys:
        # A key that moved nothing starts no animation; its window would only measure idle time.
        if not moved:
            continue
        length = PAGE_ANIMATION_MS if name in ("[", "]", "Return", "Escape") else FOCUS_ANIMATION_MS
        first = bisect.bisect_right(times, at)
        last = bisect.bisect_right(times, at + length * 1e6 + period_ms * 1e6)
        for i in range(first + 1, last):
            phases.setdefault(phase, {})[i] = presents[i][1] / 1e6

    raf_intervals = [b - a for a, b in zip(raf, raf[1:])]
    animating = [ms for samples in phases.values() for ms in samples.values()]
    # Budgets apply to the whole scripted run (docs/DESIGN.md, section 8.1); phases are diagnostic,
    # since a single missed vsync in a short phase would swamp its ratio.
    report = {
        "refresh_hz": hz,
        "raf": judge(raf_intervals, period_ms),
        "gamescope": judge(animating, period_ms),
        "phases": {phase: judge(list(samples.values()), period_ms) for phase, samples in phases.items()},
        "skipped_no_op_keys": sum(1 for key in keys if not key[3]),
    }
    report["pass"] = report["raf"]["pass"] and report["gamescope"]["pass"]
    out = DEV_ROOT / "logs" / "latest" / "perf-report.json"
    out.write_text(json.dumps({**report, "keys": keys, "presents": presents}, indent=1))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
