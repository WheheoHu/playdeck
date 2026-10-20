#!/usr/bin/env python3
"""Checks gamescope-side present intervals while UI animations are running.

During the animation that follows a key press, the compositor must present every vsync, so any longer
interval there is a real dropped frame. The first present after each press is skipped because its
interval spans the idle time before the input. Idle gaps outside animations are ignored.

Usage: analyze_presents.py <run dir with s5-presents.txt, s5-keys.json, s5-summary.json>
"""

import bisect
import json
import sys
from pathlib import Path

FOCUS_ANIMATION_MS = 140
PAGE_ANIMATION_MS = 200
PAGE_KEYS = {"[", "]"}
SAME_PRESENT_NS = 2_000_000


def load_presents(path):
    presents = []
    for line in path.read_text().splitlines():
        at, frametime = map(int, line.split())
        if not presents or at - presents[-1][0] >= SAME_PRESENT_NS:
            presents.append((at, frametime))
    return presents


def main():
    run = Path(sys.argv[1])
    refresh_hz = json.loads((run / "s5-summary.json").read_text())["budget"]["refreshHz"]
    period_ns = 1e9 / refresh_hz
    drop_ms = 1.5 * period_ns / 1e6
    presents = load_presents(run / "s5-presents.txt")
    times = [at for at, _ in presents]
    keys = json.loads((run / "s5-keys.json").read_text())

    animating = {}
    for key in keys:
        start = int(key["ns"])
        length_ms = PAGE_ANIMATION_MS if key["key"] in PAGE_KEYS else FOCUS_ANIMATION_MS
        first = bisect.bisect_right(times, start)
        last = bisect.bisect_right(times, start + length_ms * 1e6 + period_ns)
        for i in range(first + 1, last):
            animating[i] = key["phase"]

    phases = {}
    for i, phase in animating.items():
        phases.setdefault(phase, []).append(presents[i][1] / 1e6)

    report = {
        "refresh_hz": refresh_hz,
        "presents": len(presents),
        "presents_per_second": round(len(presents) / ((times[-1] - times[0]) / 1e9), 1) if len(times) > 1 else 0,
        "drop_threshold_ms": round(drop_ms, 2),
        "phases": {},
    }
    for phase, frametimes in phases.items():
        frametimes.sort()
        drops = [ft for ft in frametimes if ft > drop_ms]
        report["phases"][phase] = {
            "samples": len(frametimes),
            "median_ms": round(frametimes[len(frametimes) // 2], 2),
            "p95_ms": round(frametimes[int(len(frametimes) * 0.95)], 2),
            "max_ms": round(frametimes[-1], 2),
            "drops": len(drops),
            "drop_ratio": round(len(drops) / len(frametimes), 4),
        }
    samples = sum(p["samples"] for p in report["phases"].values())
    drops = sum(p["drops"] for p in report["phases"].values())
    report["animating_samples"] = samples
    report["animating_drops"] = drops
    report["pass"] = samples > 0 and drops / samples <= 0.01
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
