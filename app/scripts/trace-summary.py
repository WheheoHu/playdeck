#!/usr/bin/env python3
"""Summarizes a Chromium trace: the longest top-level tasks per thread and what they spent time on.

Usage: trace-summary.py trace.json [min_ms]
"""

import json
import sys
from collections import defaultdict


def main():
    path = sys.argv[1]
    min_ms = float(sys.argv[2]) if len(sys.argv) > 2 else 12
    events = json.load(open(path))
    events = events["traceEvents"] if isinstance(events, dict) else events

    threads = {}
    for event in events:
        if event.get("ph") == "M" and event.get("name") == "thread_name":
            threads[(event["pid"], event["tid"])] = event["args"]["name"]

    complete = [e for e in events if e.get("ph") == "X" and "dur" in e]
    by_thread = defaultdict(list)
    for event in complete:
        by_thread[(event["pid"], event["tid"])].append(event)

    for key, items in by_thread.items():
        name = threads.get(key, str(key))
        if not any(part in name for part in ("CrRendererMain", "Compositor", "CrGpuMain", "VizCompositor", "Raster")):
            continue
        tasks = [e for e in items if e["name"] in ("ThreadControllerImpl::RunTask", "RunTask") and e["dur"] / 1000 >= min_ms]
        if not tasks:
            continue
        print(f"\n== {name}: {len(tasks)} tasks >= {min_ms} ms")
        for task in sorted(tasks, key=lambda e: -e["dur"])[:8]:
            start, end = task["ts"], task["ts"] + task["dur"]
            inner = defaultdict(float)
            for event in items:
                if event is task or event["ts"] < start or event["ts"] + event["dur"] > end:
                    continue
                inner[event["name"]] += event["dur"] / 1000
            top = sorted(inner.items(), key=lambda kv: -kv[1])[:6]
            print(f"  {task['dur'] / 1000:6.1f} ms  " + ", ".join(f"{n} {d:.1f}" for n, d in top))


if __name__ == "__main__":
    main()
