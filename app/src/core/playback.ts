import {
  ALL_STATS_SECTIONS,
  type AudioLanguage,
  type PlaySession,
  type SessionTrack,
  type Settings,
  type SubtitleLanguage,
} from '../../shared/bridge';
import { episodeLabel } from './format';
import { type PlexContext, plexHeaders } from './plex/client';
import type { LibraryServer, MediaItem, MediaPart, MediaStream, MediaVersion } from './plex/library';
import { basicAuthHeader, buildWebDavUrl } from './webdav/client';

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
    const url = server.kind === 'webdav' ? buildWebDavUrl(server.baseUrl, stream.key) : `${server.baseUrl}${stream.key}`;
    return { id: stream.id, kind: 'subtitle', title: stream.title, language: stream.language, url, selected: stream.selected };
  }
  if (stream.index === undefined) return null;
  return { id: stream.id, kind: stream.kind, title: stream.title, language: stream.language, ffIndex: stream.index, selected: stream.selected };
}

export interface TrackPreferences {
  audioLanguage?: AudioLanguage;
  subtitleLanguage?: SubtitleLanguage;
}

/** Scores how well a stream matches a preferred language (0 = no match, higher = better). */
export function languageScore(stream: MediaStream, pref: string): number {
  if (!pref || pref === 'off') return 0;
  const tag = (stream.language ?? '').toLowerCase();
  const text = `${stream.languageName ?? ''} ${stream.title} ${stream.name ?? ''}`.toLowerCase();
  const isZh =
    tag === 'zh' ||
    tag === 'zho' ||
    tag === 'chi' ||
    tag.startsWith('zh-') ||
    /\b(chinese|cmn|yue)\b|中文|国语|粤语|普通话|简体|繁体|繁體/.test(text);
  const isHans =
    tag === 'zh-hans' ||
    tag === 'zh-cn' ||
    tag === 'zh-sg' ||
    /\b(simplified|hans|chs|sc|zh-cn)\b|简体|简中|简日|中简/.test(text);
  const isHant =
    tag === 'zh-hant' ||
    tag === 'zh-tw' ||
    tag === 'zh-hk' ||
    tag === 'zh-mo' ||
    /\b(traditional|hant|cht|tc|zh-tw|zh-hk|taiwan|hong kong)\b|繁体|繁體|繁中|繁日|中繁/.test(text);

  let base = 0;
  if (pref === 'ja') {
    if (tag === 'ja' || tag === 'jpn' || tag.startsWith('ja-') || /\bjapanese\b|日本語|日语/.test(text)) base = 20;
  } else if (pref === 'en') {
    if (tag === 'en' || tag === 'eng' || tag.startsWith('en-') || /\benglish\b/.test(text)) base = 20;
  } else if (pref === 'ko') {
    if (tag === 'ko' || tag === 'kor' || tag.startsWith('ko-') || /\bkorean\b|한국어|韩语/.test(text)) base = 20;
  } else if (pref === 'zh') {
    if (isZh) base = 20;
  } else if (pref === 'zh-Hans') {
    if (isHans) base = 20;
    else if (isZh && !isHant) base = 10;
  } else if (pref === 'zh-Hant') {
    if (isHant) base = 20;
    else if (isZh && !isHans) base = 10;
  }
  if (base === 0) return 0;
  return base + (stream.default ? 1 : 0) - (stream.hearingImpaired ? 2 : 0) - (stream.forced ? 5 : 0);
}

function bestByLanguage(tracks: SessionTrack[], streams: Map<number, MediaStream>, pref: string | undefined): SessionTrack | undefined {
  if (!pref || pref === 'off') return undefined;
  let best: SessionTrack | undefined;
  let bestScore = 0;
  for (const track of tracks) {
    const stream = streams.get(track.id);
    const score = stream ? languageScore(stream, pref) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }
  return best;
}

/**
 * The server marks the user's tracks as selected; when it marks none of a kind, the user's default
 * language preference is tried before falling back to the container default or first audio track.
 */
export function sessionTracks(part: MediaPart, server: LibraryServer, prefs?: TrackPreferences): SessionTrack[] {
  const byId = new Map(part.streams.map((stream) => [stream.id, stream]));
  const tracks = part.streams.flatMap((stream) => sessionTrack(stream, server) ?? []);
  const audio = tracks.filter((track) => track.kind === 'audio');
  if (audio.length > 0 && !audio.some((track) => track.selected)) {
    const fallback =
      bestByLanguage(audio, byId, prefs?.audioLanguage) ??
      audio.find((track) => byId.get(track.id)?.default) ??
      audio[0];
    fallback.selected = true;
  }
  const subtitles = tracks.filter((track) => track.kind === 'subtitle');
  if (subtitles.length > 0 && !subtitles.some((track) => track.selected)) {
    const preferred = bestByLanguage(subtitles, byId, prefs?.subtitleLanguage);
    if (preferred) preferred.selected = true;
  }
  return tracks;
}

export interface SessionOptions {
  /** Ignore the resume offset. */
  fromStart?: boolean;
  next?: MediaItem | null;
  settings: Pick<Settings, 'autoSkipMarkers' | 'autoplayNext' | 'networkMonitor' | 'audioLanguage' | 'subtitleLanguage'> &
    Partial<Pick<Settings, 'statsSections' | 'hdrSubtitleBrightness' | 'statsWaveform'>>;
  strings: Record<string, string>;
}

/**
 * What mpv needs for one Direct Play: the file's URL with the client's headers (the token goes in a
 * header, never the URL), where to start, the tracks to offer and the markers to act on.
 */
export function buildSession(context: PlexContext, server: LibraryServer, playable: Playable, options: SessionOptions): PlaySession {
  const { item, part, version } = playable;
  const video = part.streams.find((stream) => stream.kind === 'video');
  const duration = version.duration ?? item.duration;
  // Resuming within the last few seconds would only show the credits' end; start over instead.
  const offset = options.fromStart || !item.viewOffset || (duration && item.viewOffset > duration - 10_000) ? 0 : item.viewOffset;
  const statsSections = options.settings.statsSections ?? [...ALL_STATS_SECTIONS];
  const hdrSubtitleBrightness = options.settings.hdrSubtitleBrightness ?? 203;
  const statsWaveform = options.settings.statsWaveform === 'luma' ? 'luma' : 'rgb';

  if (server.kind === 'webdav') {
    const auth = basicAuthHeader(server.webdav?.username, server.webdav?.password);
    return {
      url: buildWebDavUrl(server.baseUrl, part.key),
      httpHeaders: auth ? [`Authorization: ${auth}`] : [],
      start: offset / 1000,
      ...playTitles(item),
      frameRate: video?.frameRate,
      bitrate: version.bitrate,
      fileSize: part.size,
      audioLanguage: options.settings.audioLanguage,
      subtitleLanguage: options.settings.subtitleLanguage,
      tracks: sessionTracks(part, server, options.settings),
      markers: item.markers.map((marker) => ({ kind: marker.kind, start: marker.start / 1000, end: marker.end / 1000 })),
      next: options.next ? playTitles(options.next) : undefined,
      autoSkipMarkers: options.settings.autoSkipMarkers,
      autoplayNext: options.settings.autoplayNext,
      networkMonitor: options.settings.networkMonitor,
      statsSections,
      statsWaveform,
      hdrSubtitleBrightness,
      strings: options.strings,
    };
  }

  const headers = plexHeaders(context, server.token);
  delete headers.Accept;
  return {
    url: `${server.baseUrl}${part.key}`,
    httpHeaders: Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    start: offset / 1000,
    ...playTitles(item),
    frameRate: video?.frameRate,
    bitrate: version.bitrate,
    tracks: sessionTracks(part, server, options.settings),
    markers: item.markers.map((marker) => ({ kind: marker.kind, start: marker.start / 1000, end: marker.end / 1000 })),
    next: options.next ? playTitles(options.next) : undefined,
    autoSkipMarkers: options.settings.autoSkipMarkers,
    autoplayNext: options.settings.autoplayNext,
    networkMonitor: options.settings.networkMonitor,
    statsSections,
    statsWaveform,
    hdrSubtitleBrightness,
    strings: options.strings,
  };
}
