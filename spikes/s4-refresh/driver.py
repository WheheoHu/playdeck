"""S4 driver: switches the internal panel to 72 Hz during 24p playback and checks that it sticks and restores.

Writing the GAMESCOPE_DYNAMIC_REFRESH root property has no effect: gamescope recomputes it every frame from the
app target refresh cycle, which is set through gamescope_control.set_app_target_refresh_cycle.
"""

import json
import os
import re
import subprocess
import time

from gamescope_control import GamescopeControl
from mpv_ipc import LOG_DIR, MpvIpc, start_mpv

ATOM = "GAMESCOPE_DYNAMIC_REFRESH"
CONTENT_FPS = 24
HAIL_MARY = os.environ.get("S4_PART", "/library/parts/2/1/p81.mkv")  # 3840x2160, 24 fps
PHASES = [("baseline", None, 20), ("switched", CONTENT_FPS, 60), ("restored", 0, 20)]
SAMPLE_INTERVAL = 2
# mpv's estimated-display-fps is a moving average; ignore samples taken while it converges.
SETTLE_SECONDS = 15

STEAM_ROOT = ["xprop", "-display", ":0", "-root"]


def read_atom(name):
    out = subprocess.run([*STEAM_ROOT, name], capture_output=True, text=True).stdout
    match = re.search(r"= (\d+)", out)
    return int(match.group(1)) if match else None


def xrandr_rate():
    out = subprocess.run(["xrandr", "--current"], capture_output=True, text=True).stdout
    match = re.search(r"(\d+\.\d+)\*", out)
    return float(match.group(1)) if match else None


def sample(mpv, phase, elapsed):
    return {
        "phase": phase,
        "t": round(elapsed, 1),
        "atom": read_atom(ATOM),
        "atom_in_steam": read_atom("GAMESCOPE_DYNAMIC_REFRESH_IN_STEAM"),
        "xrandr": xrandr_rate(),
        "display_fps": mpv.get("display-fps"),
        "estimated_display_fps": mpv.get("estimated-display-fps"),
        "vsync_jitter": mpv.get("vsync-jitter"),
        "mistimed": mpv.get("mistimed-frame-count"),
        "dropped": mpv.get("frame-drop-count"),
    }


def median(values):
    values = sorted(v for v in values if v is not None)
    return values[len(values) // 2] if values else None


def delta(samples, key):
    return samples[-1][key] - samples[0][key] if samples else None


def main():
    control = GamescopeControl()
    native_hz = max(control.display["refresh_rates"])
    target_hz = control.refresh_for(CONTENT_FPS)
    process, stderr = start_mpv("s4", HAIL_MARY, "--hwdec=vaapi", "--start=1800", "--video-sync=display-resample")
    samples = []
    summary = {
        "gamescope_control_version": control.version,
        "display": control.display,
        "native_hz": native_hz,
        "target_hz": target_hz,
    }
    try:
        mpv = MpvIpc()
        mpv.wait_event("playback-restart", 60)
        for phase, fps, duration in PHASES:
            if fps is not None:
                control.set_app_target_refresh_cycle(fps)
                mpv.command("set_property", "display-fps-override", target_hz if fps else 0)
            started = time.monotonic()
            while (elapsed := time.monotonic() - started) < duration:
                samples.append(sample(mpv, phase, elapsed))
                time.sleep(SAMPLE_INTERVAL)
        mpv.command("quit")
    except Exception as error:  # noqa: BLE001 - recorded in the summary
        summary["error"] = f"{type(error).__name__}: {error}"
        process.kill()
    finally:
        control.set_app_target_refresh_cycle(0)
        control.close()
    process.wait(timeout=30)
    stderr.close()

    switched = [s for s in samples if s["phase"] == "switched" and s["t"] >= SETTLE_SECONDS]
    restored = [s for s in samples if s["phase"] == "restored" and s["t"] >= SETTLE_SECONDS]
    switched_hz = median(s["estimated_display_fps"] for s in switched)
    restored_hz = median(s["estimated_display_fps"] for s in restored)
    summary.update({
        "switched_median_hz": switched_hz,
        "restored_median_hz": restored_hz,
        "switched_dropped": delta(switched, "dropped"),
        "switched_mistimed": delta(switched, "mistimed"),
    })
    summary["panel_switched"] = switched_hz is not None and abs(switched_hz - target_hz) < 0.6
    summary["playback_clean"] = summary["switched_dropped"] == 0 and (summary["switched_mistimed"] or 0) <= 5
    summary["panel_restored"] = restored_hz is not None and abs(restored_hz - native_hz) < 1.0
    summary["pass"] = summary["panel_switched"] and summary["playback_clean"] and summary["panel_restored"]
    summary["samples"] = samples
    (LOG_DIR / "s4-summary.json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
