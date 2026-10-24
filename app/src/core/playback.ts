import type { PlaySession, SessionTrack, Settings } from '../../shared/bridge';
import { episodeLabel } from './format';
import { type PlexContext, plexHeaders } from './plex/client';
import type { LibraryServer, MediaItem, MediaPart, MediaStream, MediaVersion } from './plex/library';

/** Plex's own threshold: past 90% an item counts as watched. */
export const WATCHED_FRACTION = 0.9;

/**
 * mpv keys for the OSD script's bindings (mpv/playdeck.lua), after docs/DESIGN.md, section 7.3. The
 * host forwards the Steam virtual pad as mpv's GAMEPAD_* keys; keyboards and remotes reach mpv directly.
 */
export const PLAYER_KEYS: Record<string, string[]> = {
  confirm: ['GAMEPAD_ACTION_DOWN', 'ENTER', 'KP_ENTER', 'SPACE', 'MBTN_LEFT'],
  back: ['GAMEPAD_ACTION_RIGHT', 'ESC', 'BS', 'MBTN_RIGHT'],
  left: ['GAMEPAD_DPAD_LEFT', 'GAMEPAD_LEFT_STICK_LEFT', 'LEFT'],
  right: ['GAMEPAD_DPAD_RIGHT', 'GAMEPAD_LEFT_STICK_RIGHT', 'RIGHT'],
  up: ['GAMEPAD_DPAD_UP', 'GAMEPAD_LEFT_STICK_UP', 'UP'],
  down: ['GAMEPAD_DPAD_DOWN', 'GAMEPAD_LEFT_STICK_DOWN', 'DOWN'],
  'prev-chapter': ['GAMEPAD_LEFT_SHOULDER', 'PGUP', 'PREV'],
  'next-chapter': ['GAMEPAD_RIGHT_SHOULDER', 'PGDWN', 'NEXT'],
  tracks: ['GAMEPAD_ACTION_UP', 'TAB'],
  stats: ['GAMEPAD_ACTION_LEFT', 'i'],
  menu: ['GAMEPAD_START', 'MENU', 'm'],
  'play-pause': ['PLAYPAUSE', 'PLAY', 'PAUSE'],
  stop: ['STOP', 'q'],
  'seek-back': ['REWIND'],
  'seek-forward': ['FORWARD'],
};

export function inputConf(keys: Record<string, string[]> = PLAYER_KEYS): string {
  return Object.entries(keys)
    .flatMap(([binding, list]) => list.map((key) => `${key} script-binding playdeck/${binding}\n`))
    .join('');
}

export interface Playable {
  item: MediaItem;
  version: MediaVersion;
  /** Multi-part (stacked) files play their first part only. */
  part: MediaPart;
}

/** The server lists the preferred version first. */
export function playableOf(item: MediaItem): Playable | null {
  for (const version of item.media) {
    const part = version.parts[0];
    if (part?.key) return { item, version, part };
  }
  return null;
}

/** "Show" over "S1 · E4 · Pilot" for episodes; the title over the year for movies. */
export function playTitles(item: MediaItem): { title: string; subtitle?: string } {
  if (item.type === 'episode') {
    return {
      title: item.grandparentTitle ?? item.title,
      subtitle: [episodeLabel(item), item.title].filter(Boolean).join(' · '),
    };
  }
  return { title: item.title, subtitle: item.year ? String(item.year) : undefined };
}

function sessionTrack(stream: MediaStream, server: LibraryServer): SessionTrack | null {
  if (stream.kind === 'video') return null;
  if (stream.key) {
    if (stream.kind !== 'subtitle') return null;
    return { id: stream.id, kind: 'subtitle', title: stream.title, language: stream.language, url: `${server.baseUrl}${stream.key}`, selected: stream.selected };
  }
  if (stream.index === undefined) return null;
  return { id: stream.id, kind: stream.kind, title: stream.title, language: stream.language, ffIndex: stream.index, selected: stream.selected };
}

/** The server marks the user's tracks as selected; when it marks no audio, the default or first plays. */
export function sessionTracks(part: MediaPart, server: LibraryServer): SessionTrack[] {
  const tracks = part.streams.flatMap((stream) => sessionTrack(stream, server) ?? []);
  const audio = tracks.filter((track) => track.kind === 'audio');
  if (audio.length > 0 && !audio.some((track) => track.selected)) {
    const fallback = audio.find((track) => part.streams.find((stream) => stream.id === track.id)?.default) ?? audio[0];
    fallback.selected = true;
  }
  return tracks;
}

export interface SessionOptions {
  /** Ignore the resume offset. */
  fromStart?: boolean;
  next?: MediaItem | null;
  settings: Pick<Settings, 'autoSkipMarkers' | 'autoplayNext' | 'networkMonitor'>;
  strings: Record<string, string>;
}

/**
 * What mpv needs for one Direct Play: the file's URL with the client's headers (the token goes in a
 * header, never the URL), where to start, the tracks to offer and the markers to act on.
 */
export function buildSession(context: PlexContext, server: LibraryServer, playable: Playable, options: SessionOptions): PlaySession {
  const { item, part, version } = playable;
  const headers = plexHeaders(context, server.token);
  delete headers.Accept;
  const video = part.streams.find((stream) => stream.kind === 'video');
  const duration = version.duration ?? item.duration;
  // Resuming within the last few seconds would only show the credits' end; start over instead.
  const offset = options.fromStart || !item.viewOffset || (duration && item.viewOffset > duration - 10_000) ? 0 : item.viewOffset;
  return {
    url: `${server.baseUrl}${part.key}`,
    httpHeaders: Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    start: offset / 1000,
    ...playTitles(item),
    frameRate: video?.frameRate,
    bitrate: version.bitrate,
    tracks: sessionTracks(part, server),
    markers: item.markers.map((marker) => ({ kind: marker.kind, start: marker.start / 1000, end: marker.end / 1000 })),
    next: options.next ? playTitles(options.next) : undefined,
    autoSkipMarkers: options.settings.autoSkipMarkers,
    autoplayNext: options.settings.autoplayNext,
    networkMonitor: options.settings.networkMonitor,
    strings: options.strings,
  };
}
