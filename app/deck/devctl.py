#!/usr/bin/env python3
"""Drives a running PlayDeck development build through its control socket (electron/devControl.ts).

Usage:
  devctl.py keys Down Down Enter     send key presses, 250 ms apart
  devctl.py capture shot.png         save a screenshot of the window
  devctl.py eval 'document.title'    evaluate JavaScript in the page
  devctl.py mpv get_property pause   run an mpv command during playback (arguments are JSON when they parse)
  devctl.py press GAMEPAD_ACTION_DOWN  press mpv keys, 400 ms apart
"""

import json
import os
import socket
import sys
import time

SOCKET = os.environ.get("PLAYDECK_DEV_CONTROL", os.path.expanduser("~/playdeck-dev/run/app-control.sock"))


def send(payload):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(SOCKET)
        sock.sendall((json.dumps(payload) + "\n").encode())
        return json.loads(sock.makefile().readline())


def parse(arg):
    try:
        return json.loads(arg)
    except ValueError:
        return arg


def main():
    command, args = sys.argv[1], sys.argv[2:]
    if command == "keys":
        for key in args:
            send({"cmd": "key", "key": key})
            time.sleep(0.25)
        print(json.dumps({"ok": True, "sent": args}))
    elif command == "capture":
        print(json.dumps(send({"cmd": "capture", "path": os.path.abspath(args[0])})))
    elif command == "eval":
        print(json.dumps(send({"cmd": "eval", "js": args[0]}), ensure_ascii=False))
    elif command == "mpv":
        print(json.dumps(send({"cmd": "mpv", "args": [parse(arg) for arg in args]}), ensure_ascii=False))
    elif command == "press":
        for key in args:
            send({"cmd": "mpv", "args": ["keypress", key]})
            time.sleep(0.4)
        print(json.dumps({"ok": True, "sent": args}))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
