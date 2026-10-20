"""Minimal client for gamescope's private gamescope_control Wayland protocol, spoken over the raw wire format.

Only requests without file descriptors are used, so no libwayland binding is needed.
"""

import os
import socket
import struct

WL_DISPLAY = 1
WL_DISPLAY_SYNC, WL_DISPLAY_GET_REGISTRY = 0, 1
WL_DISPLAY_ERROR = 0
WL_REGISTRY_BIND = 0
WL_REGISTRY_GLOBAL = 0
WL_CALLBACK_DONE = 0
CONTROL_SET_APP_TARGET_REFRESH_CYCLE = 1
CONTROL_REQUEST_APP_PERFORMANCE_STATS = 6
CONTROL_EVENT_ACTIVE_DISPLAY_INFO = 1
CONTROL_EVENT_APP_PERFORMANCE_STATS = 3

FLAG_INTERNAL_DISPLAY = 0x1
FLAG_ALLOW_REFRESH_SWITCHING = 0x2
FLAG_ONLY_CHANGE_REFRESH_RATE = 0x4


def _string(value):
    data = value.encode() + b"\0"
    return struct.pack("<I", len(data)) + data + b"\0" * (-len(data) % 4)


def _read_blob(body, offset):
    (length,) = struct.unpack_from("<I", body, offset)
    start = offset + 4
    return body[start:start + length], start + length + (-length % 4)


class GamescopeControl:
    def __init__(self):
        path = os.path.join(os.environ["XDG_RUNTIME_DIR"], os.environ.get("GAMESCOPE_WAYLAND_DISPLAY", "gamescope-0"))
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.buffer = b""
        self.next_id = 2
        self.control = None
        self.display = None
        self.registry = self._new_id()
        self._send(WL_DISPLAY, WL_DISPLAY_GET_REGISTRY, struct.pack("<I", self.registry))
        globals_ = {}
        self._roundtrip(on_global=lambda name, interface, version: globals_.__setitem__(interface, (name, version)))
        if "gamescope_control" not in globals_:
            raise RuntimeError("gamescope_control global not advertised")
        name, version = globals_["gamescope_control"]
        if version < 2:
            raise RuntimeError(f"gamescope_control v{version} lacks set_app_target_refresh_cycle")
        self.version = min(version, 7)
        self.control = self._new_id()
        self._send(self.registry, WL_REGISTRY_BIND,
                   struct.pack("<I", name) + _string("gamescope_control") + struct.pack("<II", self.version, self.control))
        self._roundtrip()

    def _new_id(self):
        object_id = self.next_id
        self.next_id += 1
        return object_id

    def _send(self, object_id, opcode, payload=b""):
        self.sock.sendall(struct.pack("<II", object_id, ((8 + len(payload)) << 16) | opcode) + payload)

    def _recv(self):
        data = self.sock.recv(65536)
        if not data:
            raise ConnectionError("gamescope closed the Wayland connection")
        self.buffer += data

    def _dispatch_until(self, done, on_global=None):
        """Handles incoming messages until done(object_id, opcode, body) returns a non-None value."""
        while True:
            while len(self.buffer) < 8:
                self._recv()
            object_id, header = struct.unpack_from("<II", self.buffer)
            size, opcode = header >> 16, header & 0xFFFF
            while len(self.buffer) < size:
                self._recv()
            body, self.buffer = self.buffer[8:size], self.buffer[size:]
            if object_id == WL_DISPLAY and opcode == WL_DISPLAY_ERROR:
                _, code = struct.unpack_from("<II", body)
                raise RuntimeError(f"wl_display error {code}: {body[12:].split(b'\0')[0].decode()}")
            if object_id == self.registry and opcode == WL_REGISTRY_GLOBAL and on_global:
                name, length = struct.unpack_from("<II", body)
                interface = body[8:8 + length - 1].decode()
                (version,) = struct.unpack_from("<I", body, 8 + length + (-length % 4))
                on_global(name, interface, version)
            if object_id == self.control and opcode == CONTROL_EVENT_ACTIVE_DISPLAY_INFO:
                self.display = self._parse_display_info(body)
            result = done(object_id, opcode, body)
            if result is not None:
                return result

    def _roundtrip(self, on_global=None):
        callback = self._new_id()
        self._send(WL_DISPLAY, WL_DISPLAY_SYNC, struct.pack("<I", callback))
        self._dispatch_until(
            lambda object_id, opcode, _body: True if object_id == callback and opcode == WL_CALLBACK_DONE else None,
            on_global,
        )

    def request_frametime(self, app_id):
        """Asks for the app's next presented frame. gamescope answers every outstanding request, so keep one."""
        self._send(self.control, CONTROL_REQUEST_APP_PERFORMANCE_STATS, struct.pack("<I", app_id))

    def wait_frametime_ns(self, timeout=None):
        """Waits for the answer to request_frametime(): the time between the app's two latest presents."""
        self.sock.settimeout(timeout)
        try:
            def done(object_id, opcode, body):
                if object_id == self.control and opcode == CONTROL_EVENT_APP_PERFORMANCE_STATS:
                    _, lo, hi = struct.unpack_from("<III", body)
                    return (hi << 32) | lo
                return None
            return self._dispatch_until(done)
        finally:
            self.sock.settimeout(None)

    @staticmethod
    def _parse_display_info(body):
        connector, offset = _read_blob(body, 0)
        make, offset = _read_blob(body, offset)
        model, offset = _read_blob(body, offset)
        (flags,) = struct.unpack_from("<I", body, offset)
        rates, _ = _read_blob(body, offset + 4)
        return {
            "connector": connector.rstrip(b"\0").decode(),
            "make": make.rstrip(b"\0").decode(),
            "model": model.rstrip(b"\0").decode(),
            "internal": bool(flags & 0x1),
            "hdr": bool(flags & 0x2),
            "vrr": bool(flags & 0x4),
            "refresh_rates": list(struct.unpack(f"<{len(rates) // 4}I", rates)),
        }

    def refresh_for(self, fps):
        """The rate gamescope will pick for a target fps: the highest valid rate that is a multiple of it."""
        rates = (self.display or {}).get("refresh_rates") or []
        return next((rate for rate in sorted(rates, reverse=True) if rate % fps == 0), None)

    def set_app_target_refresh_cycle(self, fps, internal_display=True):
        """fps=0 restores the native refresh rate. Only the refresh rate changes; no frame limiter is applied."""
        flags = FLAG_ALLOW_REFRESH_SWITCHING | FLAG_ONLY_CHANGE_REFRESH_RATE
        if internal_display:
            flags |= FLAG_INTERNAL_DISPLAY
        self._send(self.control, CONTROL_SET_APP_TARGET_REFRESH_CYCLE, struct.pack("<II", fps, flags))
        self._roundtrip()

    def close(self):
        self.sock.close()
