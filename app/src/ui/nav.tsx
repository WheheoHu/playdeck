import { createContext, useContext } from 'react';
import type { LibrarySection, MediaItem } from '../core/plex/library';

export type Tab = 'home' | 'libraries' | 'search';
export const TABS: Tab[] = ['home', 'libraries', 'search'];

export type Route =
  /** `season` and `episode` preselect inside a show. */
  | { kind: 'item'; serverId: string; ratingKey: string; season?: string; episode?: string }
  | { kind: 'library'; section: LibrarySection };

export interface Nav {
  tab: Tab;
  setTab(tab: Tab): void;
  push(route: Route): void;
  pop(): void;
  /** Opens the page a card leads to: episodes and seasons open their show. */
  open(item: MediaItem): void;
  /** The X-button menu for an item. */
  menu(item: MediaItem): void;
  toggleWatched(item: MediaItem): void;
  toast(message: string): void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('useNav outside NavContext');
  return nav;
}

export function routeFor(item: MediaItem): Route {
  if (item.type === 'episode' && item.grandparentRatingKey) {
    return {
      kind: 'item',
      serverId: item.serverId,
      ratingKey: item.grandparentRatingKey,
      season: item.parentRatingKey,
      episode: item.ratingKey,
    };
  }
  if (item.type === 'season' && item.parentRatingKey) {
    return { kind: 'item', serverId: item.serverId, ratingKey: item.parentRatingKey, season: item.ratingKey };
  }
  return { kind: 'item', serverId: item.serverId, ratingKey: item.ratingKey };
}

export function isWatched(item: MediaItem): boolean {
  if (item.type === 'show' || item.type === 'season') {
    return Boolean(item.leafCount) && item.viewedLeafCount === item.leafCount;
  }
  return Boolean(item.viewCount) && !item.viewOffset;
}
