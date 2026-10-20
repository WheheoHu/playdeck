"""Records the app's presented frame times as gamescope sees them, until terminated.

Output lines are "<CLOCK_MONOTONIC ns at receipt> <frametime ns>", so they can be aligned with the
harness key log, which uses the same clock (process.hrtime in Electron).
"""

import os
import signal
import socket
import sys
import time

from gamescope_control import GamescopeControl

running = True


def stop(_signum, _frame):
    global running
    running = False


def main():
    signal.signal(signal.SIGTERM, stop)
    app_id = int(os.environ["SteamAppId"])
    control = GamescopeControl()
    with open(sys.argv[1], "w") as out:
        control.request_frametime(app_id)
        while running:
            try:
                frametime = control.wait_frametime_ns(timeout=1)
            except socket.timeout:
                continue
            received = time.monotonic_ns()
            control.request_frametime(app_id)
            out.write(f"{received} {frametime}\n")
    control.close()


if __name__ == "__main__":
    main()
