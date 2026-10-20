import type { MediaItem } from './plex/library';

export interface HomeEntry {
  item: MediaItem;
  /** For recently added shows: how many new episodes the entry stands for. */
  newEpisodes?: number;
}

/** Poster artwork for a card: episodes and seasons show their show's poster. */
export function posterOf(item: MediaItem): string | undefined {
  if (item.type === 'episode') return item.grandparentThumb ?? item.parentThumb ?? item.thumb;
  if (item.type === 'season') return item.parentThumb ?? item.thumb;
  return item.thumb;
}

export function backdropOf(item: MediaItem): string | undefined {
  return item.art ?? item.grandparentArt;
}

/** The show an episode or season belongs to, or null for standalone items. */
function showKey(item: MediaItem): string | null {
  if (item.type === 'episode') return item.grandparentRatingKey ?? null;
  if (item.type === 'season') return item.parentRatingKey ?? null;
  return null;
}

/**
 * Merges each server's Continue Watching and On Deck hubs, most recently watched first. Like Plex Web,
 * a show appears once, preferring its in-progress episode over the next unwatched one.
 */
export function mergeContinueWatching(perServer: MediaItem[][], limit = 30): MediaItem[] {
  const byKey = new Map<string, MediaItem>();
  for (const items of perServer) {
    for (const item of items) {
      const show = showKey(item);
      const key = `${item.serverId}:${show ? `show:${show}` : item.ratingKey}`;
      const existing = byKey.get(key);
      if (!existing || (!existing.viewOffset && item.viewOffset)) byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0)).slice(0, limit);
}

/** Merges recently added items across servers, newest first, folding a show's new episodes into one entry. */
export function mergeRecentlyAdded(perServer: MediaItem[][], limit = 30): HomeEntry[] {
  const entries = new Map<string, HomeEntry>();
  for (const items of perServer) {
    for (const item of items) {
      const show = showKey(item);
      const key = `${item.serverId}:${show ? `show:${show}` : item.ratingKey}`;
      const existing = entries.get(key);
      const episodes = item.type === 'episode' ? 1 : item.type === 'season' ? (item.leafCount ?? 0) : 0;
      if (!existing) {
        entries.set(key, { item, newEpisodes: show ? episodes : undefined });
        continue;
      }
      if ((item.addedAt ?? 0) > (existing.item.addedAt ?? 0)) existing.item = item;
      if (existing.newEpisodes !== undefined) existing.newEpisodes += episodes;
    }
  }
  return [...entries.values()].sort((a, b) => (b.item.addedAt ?? 0) - (a.item.addedAt ?? 0)).slice(0, limit);
}

/** Watch progress as a 0–1 fraction, or null when there is nothing to show. */
export function progressOf(item: MediaItem): number | null {
  if (!item.viewOffset || !item.duration) return null;
  return Math.min(1, item.viewOffset / item.duration);
}
