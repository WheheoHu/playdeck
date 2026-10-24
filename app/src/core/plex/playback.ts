import { getWebDavAllLeaves, recordWebDavTimeline } from '../webdav/scanner';
import { type PlexContext, requestJson } from './client';
import { type LibraryServer, type MediaItem, type RawMetadata, parseItem } from './library';

export type TimelineState = 'playing' | 'paused' | 'stopped';

/** Milliseconds. The server keeps the resume offset from these reports and lists the session. */
export interface TimelineReport {
  ratingKey: string;
  state: TimelineState;
  time: number;
  duration: number;
}

export async function reportTimeline(context: PlexContext, server: LibraryServer, report: TimelineReport): Promise<void> {
  if (server.kind === 'webdav') {
    recordWebDavTimeline(server.id, report.ratingKey, report.state, report.time, report.duration);
    return;
  }
  const params = new URLSearchParams({
    ratingKey: report.ratingKey,
    key: `/library/metadata/${report.ratingKey}`,
    state: report.state,
    time: String(Math.round(report.time)),
    duration: String(Math.round(report.duration)),
    playbackTime: String(Math.round(report.time)),
    identifier: 'com.plexapp.plugins.library',
  });
  await requestJson(context, `${server.baseUrl}/:/timeline?${params}`, { token: server.token });
}

/**
 * Saves the user's track choice for a file, so the next playback (on any client) starts with it.
 * Subtitle 0 turns subtitles off; a missing kind is left as it is.
 */
export async function selectStreams(
  context: PlexContext,
  server: LibraryServer,
  partId: number,
  choice: { audio?: number; subtitle?: number },
): Promise<void> {
  if (server.kind === 'webdav') return;
  const params = new URLSearchParams({ allParts: '1' });
  if (choice.audio !== undefined) params.set('audioStreamID', String(choice.audio));
  if (choice.subtitle !== undefined) params.set('subtitleStreamID', String(choice.subtitle));
  await requestJson(context, `${server.baseUrl}/library/parts/${partId}?${params}`, { method: 'PUT', token: server.token });
}

/** The episode after `episode` in its show, across seasons; specials (season 0) are skipped. */
export async function fetchNextEpisode(context: PlexContext, server: LibraryServer, episode: MediaItem): Promise<MediaItem | null> {
  if (episode.type !== 'episode' || !episode.grandparentRatingKey) return null;
  if (server.kind === 'webdav') {
    return nextEpisodeIn(getWebDavAllLeaves(server.id, episode.grandparentRatingKey), episode);
  }
  const response = await requestJson<{ MediaContainer?: { Metadata?: RawMetadata[] } }>(
    context,
    `${server.baseUrl}/library/metadata/${episode.grandparentRatingKey}/allLeaves`,
    { token: server.token },
  );
  const episodes = (response.MediaContainer?.Metadata ?? []).map((raw) => parseItem(server.id, raw));
  return nextEpisodeIn(episodes, episode);
}

export function nextEpisodeIn(episodes: MediaItem[], episode: MediaItem): MediaItem | null {
  const regular = episodes.filter((other) => other.parentIndex !== 0 || episode.parentIndex === 0);
  const at = regular.findIndex((other) => other.ratingKey === episode.ratingKey);
  return at >= 0 ? (regular[at + 1] ?? null) : null;
}
