"""Minimal mpv JSON IPC client and launcher shared by the Python spike drivers."""

import json
import os
import socket
import subprocess
import time
from pathlib import Path

DEV_ROOT = Path(os.environ["PLAYDECK_DEV_ROOT"])
LOG_DIR = Path(os.environ["PLAYDECK_LOG_DIR"])
SOCKET_PATH = DEV_ROOT / "run" / "mpv.sock"
BASE_URL = os.environ["PLEX_URL"].rstrip("/")

HDR_ARGS = ["--fs", "--vo=gpu-next", "--gpu-api=vulkan", "--target-colorspace-hint=yes"]


class MpvIpc:
    def __init__(self, path=SOCKET_PATH, timeout=20):
        deadline = time.monotonic() + timeout
        while True:
            try:
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.connect(str(path))
                break
            except OSError:
                self.sock.close()
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        self.buffer = b""
        self.next_id = 1
        self.events = []

    def _read(self, timeout=None):
        self.sock.settimeout(timeout)
        while b"\n" not in self.buffer:
            data = self.sock.recv(65536)
            if not data:
                raise ConnectionError("mpv IPC closed")
            self.buffer += data
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def command(self, *args):
        request_id = self.next_id
        self.next_id += 1
        self.sock.sendall((json.dumps({"command": list(args), "request_id": request_id}) + "\n").encode())
        while True:
            message = self._read()
            if message.get("request_id") == request_id:
                if message["error"] != "success":
                    raise RuntimeError(f"{args[0]}: {message['error']}")
                return message.get("data")
            self.events.append(message)

    def get(self, name):
        try:
            return self.command("get_property", name)
        except RuntimeError:
            return None

    def wait_event(self, name, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if any(e.get("event") == name for e in self.events):
                return True
            try:
                self.events.append(self._read(timeout=1))
            except socket.timeout:
                pass
        return False

    def drain(self):
        try:
            while True:
                self.events.append(self._read(timeout=0.05))
        except (socket.timeout, ConnectionError):
            pass


def start_mpv(name, part, *extra_args):
    """Starts Flathub mpv on a Plex part with PlayDeck's HDR baseline; returns (process, log handle)."""
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    SOCKET_PATH.unlink(missing_ok=True)
    stderr = open(LOG_DIR / f"{name}.stderr.log", "w")
    process = subprocess.Popen(
        [
            "flatpak", "run", "io.mpv.Mpv",
            "--no-config",
            f"--include={DEV_ROOT / 'secrets' / 'mpv-plex.conf'}",
            *HDR_ARGS,
            "--cache=yes", "--demuxer-max-bytes=400MiB",
            f"--input-ipc-server={SOCKET_PATH}",
            f"--log-file={LOG_DIR / f'{name}.mpv.log'}", "--msg-level=all=info,vo=v",
            *extra_args,
            f"{BASE_URL}{part}",
        ],
        stdout=stderr,
        stderr=stderr,
    )
    return process, stderr
