import type { LibrarySort, WebDavLibraryConfig, WebDavWatchEntry } from '../../../shared/bridge';
import type { LibrarySection, MediaItem } from '../plex/library';
import {
  type WebDavConnection,
  type WebDavEntry,
  type WebDavTransport,
  connectionOf,
  fetchWebDavText,
  propfind,
} from './client';
import {
  type ParsedNfo,
  buildWebDavMediaVersion,
  classifyMixedFolder,
  findArtwork,
  isVideoFile,
  matchSubtitles,
  parseFilenameMetadata,
  parseNfo,
  parseSeasonFolderNumber,
  stemOf,
} from './metadata';

export interface WebDavCatalog {
  config: WebDavLibraryConfig;
  scanning: boolean;
  scannedFolders: number;
  totalFolders: number;
  error?: string;
  /** Top-level items shown in the library grid (movies and/or shows). */
  topItems: MediaItem[];
  /** Every item by ratingKey (movies, shows, seasons, episodes). */
  itemsByKey: Map<string, MediaItem>;
  /** Children by parent ratingKey (show -> seasons, season -> episodes). */
  childrenByKey: Map<string, MediaItem[]>;
  /** All episodes of a show in playback order (showRatingKey -> episodes). */
  leavesByShowKey: Map<string, MediaItem[]>;
}

export interface WebDavScanStatus {
  scanning: boolean;
  scannedItems: number;
  activeLibraries: number;
}

const catalogs = new Map<string, WebDavCatalog>();
let watchStore: Record<string, WebDavWatchEntry> = {};
let watchPersistCallback: ((store: Record<string, WebDavWatchEntry>) => void) | null = null;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let idCounter = 1;

function nextNumericId(): number {
  return idCounter++;
}

function ratingKeyForPath(prefix: string, path: string): string {
  return `${prefix}:${path}`;
}

export function subscribeWebDav(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitImmediate(): void {
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  listeners.forEach((listener) => listener());
}

function emitThrottled(): void {
  if (notifyTimer !== null) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    listeners.forEach((listener) => listener());
  }, 250);
}

export function initWebDavWatchStore(
  initial: Record<string, WebDavWatchEntry> | undefined,
  onPersist?: (store: Record<string, WebDavWatchEntry>) => void,
): void {
  watchStore = { ...(initial ?? {}) };
  if (onPersist) watchPersistCallback = onPersist;
  for (const catalog of catalogs.values()) {
    recomputeCatalogWatchState(catalog);
  }
}

export function getWebDavWatchStore(): Record<string, WebDavWatchEntry> {
  return watchStore;
}

function watchKey(serverId: string, ratingKey: string): string {
  return `${serverId}/${ratingKey}`;
}

function isItemWatched(item: MediaItem): boolean {
  return Boolean(item.viewCount) && !item.viewOffset;
}

function applyWatchToLeaf(serverId: string, item: MediaItem): void {
  const entry = watchStore[watchKey(serverId, item.ratingKey)];
  if (!entry) {
    item.viewOffset = undefined;
    item.viewCount = undefined;
    item.lastViewedAt = undefined;
    return;
  }
  item.viewOffset = entry.viewOffset;
  item.viewCount = entry.viewCount;
  item.lastViewedAt = entry.lastViewedAt;
  if (entry.duration && entry.duration > 0) {
    item.duration = entry.duration;
    if (item.media[0]) item.media[0].duration = entry.duration;
  }
}

function recomputeShowWatchState(catalog: WebDavCatalog, show: MediaItem): void {
  const serverId = catalog.config.id;
  const seasons = catalog.childrenByKey.get(show.ratingKey) ?? [];
  let showLeafCount = 0;
  let showViewedCount = 0;
  let latestViewedAt = 0;

  for (const season of seasons) {
    const episodes = catalog.childrenByKey.get(season.ratingKey) ?? [];
    let seasonViewed = 0;
    for (const ep of episodes) {
      applyWatchToLeaf(serverId, ep);
      if (isItemWatched(ep)) seasonViewed++;
      if ((ep.lastViewedAt ?? 0) > latestViewedAt) latestViewedAt = ep.lastViewedAt!;
    }
    season.leafCount = episodes.length;
    season.viewedLeafCount = seasonViewed;
    if (season.index !== 0 || seasons.length === 1) {
      showLeafCount += episodes.length;
      showViewedCount += seasonViewed;
    }
  }

  show.leafCount = showLeafCount;
  show.viewedLeafCount = showViewedCount;
  show.childCount = seasons.length;
  show.lastViewedAt = latestViewedAt || undefined;
}

function recomputeCatalogWatchState(catalog: WebDavCatalog): void {
  const serverId = catalog.config.id;
  for (const item of catalog.topItems) {
    if (item.type === 'movie') {
      applyWatchToLeaf(serverId, item);
    } else if (item.type === 'show') {
      recomputeShowWatchState(catalog, item);
    }
  }
}

async function tryReadNfo(
  transport: WebDavTransport,
  conn: WebDavConnection,
  entries: WebDavEntry[],
  candidates: string[],
): Promise<ParsedNfo | null> {
  const byNameLower = new Map(entries.filter((e) => !e.isDirectory).map((e) => [e.name.toLowerCase(), e.path]));
  for (const candidate of candidates) {
    const path = byNameLower.get(candidate.toLowerCase());
    if (!path) continue;
    try {
      const xml = await fetchWebDavText(transport, conn, path, 8000);
      return parseNfo(xml);
    } catch {
      // Ignore unreadable NFO files and fall back to filename metadata.
    }
  }
  return null;
}

function createMovieItem(
  config: WebDavLibraryConfig,
  videoEntry: WebDavEntry,
  folderEntries: WebDavEntry[],
  nfo: ParsedNfo | null,
  fallbackFolderTitle?: string,
): MediaItem {
  const fileMeta = parseFilenameMetadata(videoEntry.name, false);
  const folderMeta = fallbackFolderTitle ? parseFilenameMetadata(fallbackFolderTitle, true) : undefined;
  const artwork = findArtwork(folderEntries, videoEntry.name);
  const subtitles = matchSubtitles(videoEntry.name, folderEntries, nextNumericId() * 100);
  const duration = nfo?.duration;
  const version = buildWebDavMediaVersion(videoEntry, fileMeta, duration, subtitles, nextNumericId());

  const item: MediaItem = {
    serverId: config.id,
    ratingKey: ratingKeyForPath('movie', videoEntry.path),
    type: 'movie',
    title: nfo?.title ?? folderMeta?.title ?? fileMeta.title,
    year: nfo?.year ?? folderMeta?.year ?? fileMeta.year,
    summary: nfo?.summary,
    tagline: nfo?.tagline,
    thumb: artwork.poster,
    art: artwork.art,
    logo: artwork.logo,
    contentRating: nfo?.contentRating,
    audienceRating: nfo?.audienceRating,
    studio: nfo?.studio,
    duration,
    addedAt: videoEntry.lastModified ?? Math.floor(Date.now() / 1000),
    originallyAvailableAt: nfo?.originallyAvailableAt,
    librarySectionId: 'main',
    genres: nfo?.genres ?? [],
    directors: nfo?.directors ?? [],
    cast: nfo?.cast ?? [],
    media: [version],
    markers: [],
  };
  applyWatchToLeaf(config.id, item);
  return item;
}

interface RawEpisodeEntry {
  videoEntry: WebDavEntry;
  folderEntries: WebDavEntry[];
  seasonHint?: number;
}

async function scanShowFolder(
  transport: WebDavTransport,
  conn: WebDavConnection,
  config: WebDavLibraryConfig,
  showDir: WebDavEntry,
  children?: WebDavEntry[],
): Promise<{ show: MediaItem; seasons: MediaItem[]; episodesBySeason: Map<string, MediaItem[]>; allLeaves: MediaItem[] } | null> {
  const dirEntries = children ?? (await propfind(transport, conn, showDir.path));
  const showNfo = await tryReadNfo(transport, conn, dirEntries, ['tvshow.nfo', `${showDir.name}.nfo`]);
  const showMeta = parseFilenameMetadata(showDir.name, true);
  const showArt = findArtwork(dirEntries);
  const showRatingKey = ratingKeyForPath('show', showDir.path);
  const showTitle = showNfo?.title ?? showMeta.title;

  const rawEpisodes: RawEpisodeEntry[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory && isVideoFile(entry.name)) {
      rawEpisodes.push({ videoEntry: entry, folderEntries: dirEntries });
    }
  }

  const subdirs = dirEntries.filter((e) => e.isDirectory);
  for (const subdir of subdirs) {
    const seasonHint = parseSeasonFolderNumber(subdir.name);
    let subEntries: WebDavEntry[];
    try {
      subEntries = await propfind(transport, conn, subdir.path);
    } catch {
      continue;
    }
    for (const entry of subEntries) {
      if (!entry.isDirectory && isVideoFile(entry.name)) {
        rawEpisodes.push({ videoEntry: entry, folderEntries: subEntries, seasonHint });
      }
    }
  }

  if (rawEpisodes.length === 0) return null;

  const seasonGroups = new Map<number, MediaItem[]>();
  let latestAddedAt = showDir.lastModified ?? 0;
  let fallbackEpIndex = 1;

  for (const raw of rawEpisodes) {
    const stem = stemOf(raw.videoEntry.name);
    const epNfo = await tryReadNfo(transport, conn, raw.folderEntries, [`${stem}.nfo`]);
    const fileMeta = parseFilenameMetadata(raw.videoEntry.name, false);
    const seasonNum = epNfo?.season ?? fileMeta.season ?? raw.seasonHint ?? 1;
    const epNum = epNfo?.episode ?? fileMeta.episode ?? fallbackEpIndex++;
    const seasonRatingKey = `${showRatingKey}:s${seasonNum}`;

    const epArt = findArtwork(raw.folderEntries, raw.videoEntry.name);
    const subtitles = matchSubtitles(raw.videoEntry.name, raw.folderEntries, nextNumericId() * 100);
    const duration = epNfo?.duration ?? showNfo?.duration;
    const version = buildWebDavMediaVersion(raw.videoEntry, fileMeta, duration, subtitles, nextNumericId());
    const addedAt = raw.videoEntry.lastModified ?? showDir.lastModified ?? Math.floor(Date.now() / 1000);
    if (addedAt > latestAddedAt) latestAddedAt = addedAt;

    const epTitle = epNfo?.title ?? fileMeta.episodeTitle ?? (`Episode ${epNum}`);
    const episodeItem: MediaItem = {
      serverId: config.id,
      ratingKey: ratingKeyForPath('ep', raw.videoEntry.path),
      type: 'episode',
      title: epTitle,
      year: epNfo?.year ?? showNfo?.year ?? showMeta.year,
      summary: epNfo?.summary ?? showNfo?.summary,
      thumb: epArt.poster ?? showArt.art ?? showArt.poster,
      art: showArt.art ?? epArt.art,
      audienceRating: epNfo?.audienceRating ?? showNfo?.audienceRating,
      duration,
      addedAt,
      originallyAvailableAt: epNfo?.originallyAvailableAt,
      index: epNum,
      parentIndex: seasonNum,
      parentTitle: seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`,
      parentRatingKey: seasonRatingKey,
      parentThumb: showArt.poster,
      grandparentTitle: showTitle,
      grandparentRatingKey: showRatingKey,
      grandparentThumb: showArt.poster,
      grandparentArt: showArt.art,
      librarySectionId: 'main',
      genres: showNfo?.genres ?? [],
      directors: epNfo?.directors?.length ? epNfo.directors : (showNfo?.directors ?? []),
      cast: showNfo?.cast ?? [],
      media: [version],
      markers: [],
    };
    applyWatchToLeaf(config.id, episodeItem);

    const list = seasonGroups.get(seasonNum) ?? [];
    list.push(episodeItem);
    seasonGroups.set(seasonNum, list);
  }

  const seasonNumbers = [...seasonGroups.keys()].sort((a, b) => {
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a - b;
  });

  const seasons: MediaItem[] = [];
  const episodesBySeason = new Map<string, MediaItem[]>();
  const allLeaves: MediaItem[] = [];

  for (const seasonNum of seasonNumbers) {
    const episodes = (seasonGroups.get(seasonNum) ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const seasonRatingKey = `${showRatingKey}:s${seasonNum}`;
    const seasonItem: MediaItem = {
      serverId: config.id,
      ratingKey: seasonRatingKey,
      type: 'season',
      title: seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`,
      index: seasonNum,
      thumb: showArt.poster,
      art: showArt.art,
      parentTitle: showTitle,
      parentRatingKey: showRatingKey,
      parentThumb: showArt.poster,
      leafCount: episodes.length,
      viewedLeafCount: episodes.filter(isItemWatched).length,
      addedAt: Math.max(...episodes.map((e) => e.addedAt ?? 0), 0),
      librarySectionId: 'main',
      genres: [],
      directors: [],
      cast: [],
      media: [],
      markers: [],
    };
    seasons.push(seasonItem);
    episodesBySeason.set(seasonRatingKey, episodes);
    allLeaves.push(...episodes);
  }

  const showItem: MediaItem = {
    serverId: config.id,
    ratingKey: showRatingKey,
    type: 'show',
    title: showTitle,
    year: showNfo?.year ?? showMeta.year,
    summary: showNfo?.summary,
    tagline: showNfo?.tagline,
    thumb: showArt.poster,
    art: showArt.art,
    logo: showArt.logo,
    contentRating: showNfo?.contentRating,
    audienceRating: showNfo?.audienceRating,
    studio: showNfo?.studio,
    addedAt: latestAddedAt || Math.floor(Date.now() / 1000),
    originallyAvailableAt: showNfo?.originallyAvailableAt,
    leafCount: allLeaves.length,
    viewedLeafCount: allLeaves.filter(isItemWatched).length,
    childCount: seasons.length,
    librarySectionId: 'main',
    genres: showNfo?.genres ?? [],
    directors: showNfo?.directors ?? [],
    cast: showNfo?.cast ?? [],
    media: [],
    markers: [],
  };

  return { show: showItem, seasons, episodesBySeason, allLeaves };
}

async function scanMovieFolder(
  transport: WebDavTransport,
  conn: WebDavConnection,
  config: WebDavLibraryConfig,
  movieDir: WebDavEntry,
  children?: WebDavEntry[],
): Promise<MediaItem[]> {
  const dirEntries = children ?? (await propfind(transport, conn, movieDir.path));
  const videos = dirEntries.filter((e) => !e.isDirectory && isVideoFile(e.name));
  if (videos.length === 0) return [];

  const folderNfo = await tryReadNfo(transport, conn, dirEntries, ['movie.nfo', `${movieDir.name}.nfo`]);
  const movies: MediaItem[] = [];
  for (const video of videos) {
    const videoNfo =
      (await tryReadNfo(transport, conn, dirEntries, [`${stemOf(video.name)}.nfo`])) ??
      (videos.length === 1 ? folderNfo : null);
    movies.push(createMovieItem(config, video, dirEntries, videoNfo, videos.length === 1 ? movieDir.name : undefined));
  }
  return movies;
}

function registerShowInCatalog(
  catalog: WebDavCatalog,
  result: { show: MediaItem; seasons: MediaItem[]; episodesBySeason: Map<string, MediaItem[]>; allLeaves: MediaItem[] },
): void {
  const { show, seasons, episodesBySeason, allLeaves } = result;
  catalog.topItems = [...catalog.topItems.filter((item) => item.ratingKey !== show.ratingKey), show];
  catalog.itemsByKey.set(show.ratingKey, show);
  catalog.childrenByKey.set(show.ratingKey, seasons);
  catalog.leavesByShowKey.set(show.ratingKey, allLeaves);
  for (const season of seasons) {
    catalog.itemsByKey.set(season.ratingKey, season);
    const episodes = episodesBySeason.get(season.ratingKey) ?? [];
    catalog.childrenByKey.set(season.ratingKey, episodes);
    for (const episode of episodes) {
      catalog.itemsByKey.set(episode.ratingKey, episode);
    }
  }
  recomputeShowWatchState(catalog, show);
}

function registerMovieInCatalog(catalog: WebDavCatalog, movie: MediaItem): void {
  catalog.topItems = [...catalog.topItems.filter((item) => item.ratingKey !== movie.ratingKey), movie];
  catalog.itemsByKey.set(movie.ratingKey, movie);
}

/**
 * Scans a single WebDAV library progressively, updating its catalog as folders complete so the
 * Home and Library screens populate in real time.
 */
export async function scanWebDavLibrary(
  transport: WebDavTransport,
  config: WebDavLibraryConfig,
  signal?: AbortSignal,
): Promise<WebDavCatalog> {
  const conn = connectionOf(config);
  const existing = catalogs.get(config.id);
  const catalog: WebDavCatalog = {
    config,
    scanning: true,
    scannedFolders: 0,
    totalFolders: existing?.totalFolders ?? 0,
    topItems: [],
    itemsByKey: new Map(),
    childrenByKey: new Map(),
    leavesByShowKey: new Map(),
  };
  catalogs.set(config.id, catalog);
  emitImmediate();

  try {
    const rootEntries = await propfind(transport, conn, config.rootPath);
    if (signal?.aborted) return catalog;

    const subdirs = rootEntries.filter((e) => e.isDirectory);
    const rootVideos = rootEntries.filter((e) => !e.isDirectory && isVideoFile(e.name));
    catalog.totalFolders = subdirs.length + (rootVideos.length > 0 ? 1 : 0);
    emitThrottled();

    // Handle video files placed directly inside rootPath.
    if (rootVideos.length > 0) {
      const rootFolderName = config.rootPath.split('/').filter(Boolean).pop() || config.name;
      const rootDirEntry: WebDavEntry = { path: config.rootPath, name: rootFolderName, isDirectory: true };
      const rootHasShowSignal =
        config.type === 'show' ||
        (config.type === 'mixed' &&
          (rootEntries.some((e) => e.name.toLowerCase() === 'tvshow.nfo') ||
            rootVideos.some((v) => parseFilenameMetadata(v.name).episode !== undefined)));

      if (rootHasShowSignal && subdirs.length === 0) {
        const showRes = await scanShowFolder(transport, conn, config, rootDirEntry, rootEntries);
        if (showRes && !signal?.aborted) registerShowInCatalog(catalog, showRes);
      } else {
        for (const video of rootVideos) {
          if (signal?.aborted) return catalog;
          const nfo = await tryReadNfo(transport, conn, rootEntries, [`${stemOf(video.name)}.nfo`, 'movie.nfo']);
          const movie = createMovieItem(config, video, rootEntries, nfo);
          registerMovieInCatalog(catalog, movie);
        }
      }
      catalog.scannedFolders += 1;
      emitThrottled();
    }

    // Handle each child directory progressively.
    for (const dir of subdirs) {
      if (signal?.aborted) return catalog;
      try {
        if (config.type === 'movie') {
          const movies = await scanMovieFolder(transport, conn, config, dir);
          if (signal?.aborted) return catalog;
          for (const movie of movies) registerMovieInCatalog(catalog, movie);
        } else if (config.type === 'show') {
          const showRes = await scanShowFolder(transport, conn, config, dir);
          if (signal?.aborted) return catalog;
          if (showRes) registerShowInCatalog(catalog, showRes);
        } else {
          // Mixed mode: inspect directory contents first to classify as movie or show.
          const children = await propfind(transport, conn, dir.path);
          if (signal?.aborted) return catalog;
          const kind = classifyMixedFolder(dir, children);
          if (kind === 'show') {
            const showRes = await scanShowFolder(transport, conn, config, dir, children);
            if (showRes && !signal?.aborted) registerShowInCatalog(catalog, showRes);
          } else {
            const movies = await scanMovieFolder(transport, conn, config, dir, children);
            if (!signal?.aborted) {
              for (const movie of movies) registerMovieInCatalog(catalog, movie);
            }
          }
        }
      } catch {
        // Skip unreadable subdirectory and continue scanning the rest.
      }
      catalog.scannedFolders += 1;
      emitThrottled();
    }
  } catch (error) {
    catalog.error = error instanceof Error ? error.message : String(error);
  } finally {
    catalog.scanning = false;
    emitImmediate();
  }

  return catalog;
}

export function removeWebDavCatalog(id: string): void {
  if (catalogs.delete(id)) emitImmediate();
}

export function getWebDavCatalog(id: string): WebDavCatalog | undefined {
  return catalogs.get(id);
}

export function getWebDavScanStatus(): WebDavScanStatus {
  let scanning = false;
  let scannedItems = 0;
  let activeLibraries = 0;
  for (const catalog of catalogs.values()) {
    if (catalog.scanning) {
      scanning = true;
      activeLibraries += 1;
    }
    scannedItems += catalog.topItems.length;
  }
  return { scanning, scannedItems, activeLibraries };
}

export function getWebDavSections(serverId: string): LibrarySection[] {
  const catalog = catalogs.get(serverId);
  if (!catalog) return [];
  return [
    {
      serverId,
      key: 'main',
      type: catalog.config.type,
      title: catalog.config.name,
      isWebDav: true,
    },
  ];
}

export function getWebDavContinueWatching(serverId: string, count = 20): MediaItem[] {
  const catalog = catalogs.get(serverId);
  if (!catalog) return [];
  const results: MediaItem[] = [];

  for (const item of catalog.topItems) {
    if (item.type === 'movie') {
      if (item.viewOffset && item.viewOffset > 0) results.push(item);
    } else if (item.type === 'show') {
      const leaves = catalog.leavesByShowKey.get(item.ratingKey) ?? [];
      const inProgress = leaves
        .filter((ep) => ep.viewOffset && ep.viewOffset > 0)
        .sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0))[0];
      if (inProgress) {
        results.push(inProgress);
        continue;
      }
      // On Deck: if at least one episode was watched, offer the first unwatched episode after the last watched one.
      let lastWatchedIdx = -1;
      let latestViewedAt = 0;
      for (let i = 0; i < leaves.length; i++) {
        if (isItemWatched(leaves[i])) {
          lastWatchedIdx = i;
          if ((leaves[i].lastViewedAt ?? 0) > latestViewedAt) latestViewedAt = leaves[i].lastViewedAt!;
        }
      }
      if (lastWatchedIdx >= 0 && lastWatchedIdx + 1 < leaves.length) {
        const nextEp = { ...leaves[lastWatchedIdx + 1], lastViewedAt: latestViewedAt };
        results.push(nextEp);
      }
    }
  }

  return results.sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0)).slice(0, count);
}

export function getWebDavRecentlyAdded(serverId: string, type: 1 | 2, count = 30): MediaItem[] {
  const catalog = catalogs.get(serverId);
  if (!catalog) return [];
  if (type === 1) {
    return catalog.topItems
      .filter((item) => item.type === 'movie')
      .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
      .slice(0, count);
  }
  const episodes: MediaItem[] = [];
  for (const leaves of catalog.leavesByShowKey.values()) {
    episodes.push(...leaves);
  }
  return episodes.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)).slice(0, count);
}

function sortWebDavItems(items: MediaItem[], sort: LibrarySort): MediaItem[] {
  const copy = [...items];
  switch (sort) {
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    case 'added':
      return copy.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    case 'released':
      return copy.sort((a, b) => {
        const dateA = a.originallyAvailableAt ?? (a.year ? `${a.year}-01-01` : '');
        const dateB = b.originallyAvailableAt ?? (b.year ? `${b.year}-01-01` : '');
        return dateB.localeCompare(dateA);
      });
    case 'rating':
      return copy.sort((a, b) => (b.audienceRating ?? 0) - (a.audienceRating ?? 0));
    case 'watched':
      return copy.sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0));
  }
}

export function getWebDavSectionPage(
  serverId: string,
  start: number,
  size: number,
  sort: LibrarySort = 'title',
): { items: MediaItem[]; totalSize: number } {
  const catalog = catalogs.get(serverId);
  if (!catalog) return { items: [], totalSize: 0 };
  const sorted = sortWebDavItems(catalog.topItems, sort);
  return {
    items: sorted.slice(start, start + size),
    totalSize: sorted.length,
  };
}

export function getWebDavItem(serverId: string, ratingKey: string): MediaItem {
  const catalog = catalogs.get(serverId);
  const item = catalog?.itemsByKey.get(ratingKey);
  if (!item) throw new Error(`WebDAV item ${ratingKey} not found`);
  return item;
}

export function getWebDavChildren(serverId: string, ratingKey: string): MediaItem[] {
  const catalog = catalogs.get(serverId);
  return catalog?.childrenByKey.get(ratingKey) ?? [];
}

export function getWebDavAllLeaves(serverId: string, showRatingKey: string): MediaItem[] {
  const catalog = catalogs.get(serverId);
  return catalog?.leavesByShowKey.get(showRatingKey) ?? [];
}

export function searchWebDav(serverId: string, query: string, limit = 20): MediaItem[] {
  const catalog = catalogs.get(serverId);
  if (!catalog) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: MediaItem[] = [];
  for (const item of catalog.itemsByKey.values()) {
    if (item.type !== 'movie' && item.type !== 'show' && item.type !== 'episode') continue;
    if (item.title.toLowerCase().includes(q) || item.grandparentTitle?.toLowerCase().includes(q)) {
      results.push(item);
      if (results.length >= limit) break;
    }
  }
  return results;
}

function persistWatch(): void {
  watchPersistCallback?.(watchStore);
}

/** Updates local playback progress or watched state for a WebDAV item. */
export function recordWebDavTimeline(
  serverId: string,
  ratingKey: string,
  state: 'playing' | 'paused' | 'stopped',
  timeMs: number,
  durationMs: number,
): void {
  const key = watchKey(serverId, ratingKey);
  const prev = watchStore[key] ?? {};
  const now = Math.floor(Date.now() / 1000);
  // Keep offsets only after 30s of playback so brief checks do not clutter Continue Watching.
  const offset = timeMs >= 30_000 && (!durationMs || timeMs < durationMs * 0.9) ? Math.round(timeMs) : prev.viewOffset;
  watchStore[key] = {
    ...prev,
    viewOffset: state === 'stopped' && timeMs < 30_000 ? prev.viewOffset : offset,
    duration: durationMs > 0 ? Math.round(durationMs) : prev.duration,
    lastViewedAt: now,
  };
  const catalog = catalogs.get(serverId);
  if (catalog) recomputeCatalogWatchState(catalog);
  if (state === 'stopped' || state === 'paused') persistWatch();
}

export function setWebDavWatched(serverId: string, ratingKey: string, watched: boolean): void {
  const catalog = catalogs.get(serverId);
  const now = Math.floor(Date.now() / 1000);

  const applySingle = (leafKey: string) => {
    const key = watchKey(serverId, leafKey);
    const prev = watchStore[key] ?? {};
    if (watched) {
      watchStore[key] = {
        ...prev,
        viewOffset: undefined,
        viewCount: (prev.viewCount ?? 0) + 1,
        lastViewedAt: now,
      };
    } else {
      delete watchStore[key];
    }
  };

  const target = catalog?.itemsByKey.get(ratingKey);
  if (target?.type === 'show') {
    for (const leaf of catalog?.leavesByShowKey.get(ratingKey) ?? []) {
      applySingle(leaf.ratingKey);
    }
  } else if (target?.type === 'season') {
    for (const leaf of catalog?.childrenByKey.get(ratingKey) ?? []) {
      applySingle(leaf.ratingKey);
    }
  } else {
    applySingle(ratingKey);
  }

  if (catalog) recomputeCatalogWatchState(catalog);
  persistWatch();
  emitImmediate();
}
