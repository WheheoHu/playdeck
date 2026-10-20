#!/usr/bin/env python3
"""Inspect Plex libraries and media streams for spike planning.

Reads PLEX_URL and PLEX_TOKEN from the repository's .env. Output never includes the token
unless `url --with-token` is requested, which is meant for piping, not for display.
"""

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

VIDEO, AUDIO, SUBTITLE = 1, 2, 3
VIDEO_FIELDS = [
    "codec", "profile", "bitDepth", "width", "height", "frameRate", "colorPrimaries", "colorTrc",
    "colorSpace", "DOVIPresent", "DOVIProfile", "DOVILevel", "DOVIBLCompatID", "DOVIBLPresent",
    "DOVIELPresent", "DOVIRPUPresent", "bitrate", "extendedDisplayTitle",
]


def load_env():
    env = {}
    for line in (REPO_ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env["PLEX_URL"].rstrip("/"), env["PLEX_TOKEN"]


class Plex:
    def __init__(self):
        self.base, self.token = load_env()

    def get(self, path, **params):
        query = urllib.parse.urlencode(params)
        request = urllib.request.Request(
            f"{self.base}{path}{'?' + query if query else ''}",
            headers={
                "Accept": "application/json",
                "X-Plex-Token": self.token,
                "X-Plex-Product": "PlayDeck",
                "X-Plex-Client-Identifier": "playdeck-spike",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)["MediaContainer"]

    def sections(self):
        return self.get("/library/sections").get("Directory", [])

    def section_key(self, title):
        for section in self.sections():
            if section["title"].lower() == title.lower():
                return section["key"]
        raise SystemExit(f"library not found: {title}")

    def part_url(self, part_key, with_token):
        url = f"{self.base}{part_key}"
        return f"{url}?X-Plex-Token={self.token}" if with_token else url


def cmd_sections(plex, _args):
    for section in plex.sections():
        print(f"{section['key']:>4}  {section['type']:<7} {section['title']}")


def cmd_find(plex, args):
    items = plex.get(f"/library/sections/{plex.section_key(args.library)}/all", title=args.query).get("Metadata", [])
    for item in items:
        print(f"{item['ratingKey']:>8}  {item['type']:<8} {item['title']} ({item.get('year', '?')})")


def cmd_children(plex, args):
    for item in plex.get(f"/library/metadata/{args.rating_key}/children").get("Metadata", []):
        print(f"{item['ratingKey']:>8}  {item['type']:<8} {item.get('index', '')!s:>3}  {item['title']}")


def cmd_media(plex, args):
    item = plex.get(f"/library/metadata/{args.rating_key}", includeMarkers=1)["Metadata"][0]
    print(f"{item['type']}: {item.get('grandparentTitle', '') + ' - ' if 'grandparentTitle' in item else ''}{item['title']}")
    for marker in item.get("Marker", []):
        print(f"  marker {marker['type']}: {marker['startTimeOffset'] / 1000:.1f}s - {marker['endTimeOffset'] / 1000:.1f}s")
    for media in item.get("Media", []):
        print(f"  media id={media['id']} container={media.get('container')} bitrate={media.get('bitrate')}kbps "
              f"duration={media.get('duration', 0) / 60000:.1f}min")
        for part in media.get("Part", []):
            print(f"    part key={part['key']} size={part.get('size', 0) / 2**30:.2f}GiB file={Path(part.get('file', '')).name}")
            for stream in part.get("Stream", []):
                kind = stream["streamType"]
                if kind == VIDEO:
                    details = {k: stream[k] for k in VIDEO_FIELDS if k in stream}
                    print(f"      video  {json.dumps(details, ensure_ascii=False)}")
                elif kind == AUDIO:
                    print(f"      audio  id={stream['id']} {stream.get('displayTitle')} default={stream.get('default', False)}")
                elif kind == SUBTITLE:
                    external = " external" if "key" in stream else ""
                    print(f"      sub    id={stream['id']} {stream.get('displayTitle')}{external} forced={stream.get('forced', False)}")


def cmd_url(plex, args):
    item = plex.get(f"/library/metadata/{args.rating_key}")["Metadata"][0]
    print(plex.part_url(item["Media"][0]["Part"][0]["key"], args.with_token))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sections")
    find = commands.add_parser("find")
    find.add_argument("library")
    find.add_argument("query")
    for name in ("children", "media", "url"):
        sub = commands.add_parser(name)
        sub.add_argument("rating_key")
        if name == "url":
            sub.add_argument("--with-token", action="store_true")
    args = parser.parse_args()
    handlers = {"sections": cmd_sections, "find": cmd_find, "children": cmd_children, "media": cmd_media, "url": cmd_url}
    try:
        handlers[args.command](Plex(), args)
    except urllib.error.HTTPError as error:
        sys.exit(f"HTTP {error.code} for {error.url.split('?')[0]}")


if __name__ == "__main__":
    main()
