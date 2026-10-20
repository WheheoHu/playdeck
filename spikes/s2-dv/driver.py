"""S2 driver: runs mpv scenarios over JSON IPC and records Dolby Vision, HDR and frame-drop evidence."""

import json
import os
import time

from mpv_ipc import LOG_DIR, MpvIpc, start_mpv

P5_AMAZE = os.environ.get("S2_P5_PART", "/library/parts/1/1/p5.mp4")  # DV Profile 5, 3840x2160, 60 fps
P81_HAIL_MARY = os.environ.get("S2_P81_PART", "/library/parts/2/1/p81.mkv")  # DV 8.1 + HDR10+, 3840x2160, 24 fps

SCENARIOS = [
    {"name": "p5-sw", "part": P5_AMAZE, "start": 20, "hwdec": "no", "play": 0},
    {"name": "p5-vaapi", "part": P5_AMAZE, "start": 20, "hwdec": "vaapi", "play": 30},
    {"name": "p5-vaapi-no-rpu", "part": P5_AMAZE, "start": 20, "hwdec": "vaapi", "play": 0,
     "extra": ["--vf=format=dolbyvision=no"]},
    {"name": "p81-vaapi-5min", "part": P81_HAIL_MARY, "start": 1800, "hwdec": "vaapi", "play": 300},
]

STATS = [
    "hwdec-current", "video-params", "video-target-params", "container-fps", "estimated-vf-fps", "display-fps",
    "frame-drop-count", "decoder-frame-drop-count", "vo-delayed-frame-count", "mistimed-frame-count",
]


def run(scenario):
    name = scenario["name"]
    process, stderr = start_mpv(
        name,
        scenario["part"],
        f"--hwdec={scenario['hwdec']}",
        "--pause", f"--start={scenario['start']}", "--keep-open=yes",
        "--screenshot-format=png", "--screenshot-tag-colorspace=no", "--screenshot-high-bit-depth=no",
        *scenario.get("extra", []),
    )
    result = {"name": name, "hwdec_requested": scenario["hwdec"]}
    try:
        mpv = MpvIpc()
        mpv.command("observe_property", 1, "paused-for-cache")
        result["first_frame"] = mpv.wait_event("playback-restart", 60)
        time.sleep(2)
        screenshot = LOG_DIR / f"{name}.png"
        mpv.command("screenshot-to-file", str(screenshot), "video")
        result["screenshot"] = screenshot.name

        if scenario["play"]:
            mpv.command("set_property", "pause", False)
            end = scenario["start"] + scenario["play"]
            deadline = time.monotonic() + scenario["play"] + 120
            while (mpv.get("time-pos") or 0) < end and not mpv.get("eof-reached"):
                if time.monotonic() > deadline:
                    raise TimeoutError("playback did not reach the target position")
                time.sleep(1)
            mpv.drain()
        result["played_seconds"] = scenario["play"]
        result["cache_stalls"] = sum(
            1 for e in mpv.events
            if e.get("event") == "property-change" and e.get("name") == "paused-for-cache" and e.get("data") is True
        )
        result.update({key: mpv.get(key) for key in STATS})
        mpv.command("quit")
    except Exception as error:  # noqa: BLE001 - every failure is recorded in the summary
        result["error"] = f"{type(error).__name__}: {error}"
        process.kill()
    result["exit_code"] = process.wait(timeout=30)
    stderr.close()
    return result


def main():
    results = []
    for scenario in SCENARIOS:
        results.append(run(scenario))
        (LOG_DIR / "s2-summary.json").write_text(json.dumps(results, indent=2))
        time.sleep(2)


if __name__ == "__main__":
    main()
