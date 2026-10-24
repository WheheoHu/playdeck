import type { LibrarySort, WebDavLibraryConfig } from '../../../shared/bridge';
import { webdavImageProxyUrl } from '../webdav/client';
import {
  getWebDavChildren,
  getWebDavContinueWatching,
  getWebDavItem,
  getWebDavRecentlyAdded,
  getWebDavSectionPage,
  getWebDavSections,
  searchWebDav,
  setWebDavWatched,
} from '../webdav/scanner';
import { type PlexContext, type RequestOptions, requestJson } from './client';

/** A server PlayDeck is connected to: where to reach it and the user's token for it. */
export interface LibraryServer {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  kind?: 'plex' | 'webdav';
  webdav?: WebDavLibraryConfig;
}

export type ItemType = 'movie' | 'show' | 'season' | 'episode' | 'collection' | 'clip' | 'other';

export interface UltraBlur {
  topLeft: string;
  topRight: string;
  bottomRight: string;
  bottomLeft: string;
}

export interface MediaStream {
  id: number;
  kind: 'video' | 'audio' | 'subtitle';
  codec?: string;
  /** BCP 47 tag, e.g. "ja". */
  language?: string;
  /** The server's display name for the language, e.g. "Japanese". */
  languageName?: string;
  /** The server's composed label, e.g. "Simplified (Chinese ASS)". */
  title: string;
  /** The track's own name from the file, e.g. "Simplified" or "Commentary". */
  name?: string;
  /** The stream's index in the container; absent for sidecar files. */
  index?: number;
  /** The track the server will play for this user: their last choice or their language preference. */
  selected: boolean;
  /** Path of a sidecar subtitle file on the server. */
  key?: string;
  default: boolean;
  forced: boolean;
  external: boolean;
  hearingImpaired: boolean;
  profile?: string;
  /** Kbps. */
  bitrate?: number;
  bitDepth?: number;
  /** Video only. */
  level?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  scanType?: string;
  refFrames?: number;
  colorPrimaries?: string;
  colorSpace?: string;
  colorTrc?: string;
  colorRange?: string;
  chromaSubsampling?: string;
  chromaLocation?: string;
  dolbyVision: boolean;
  doviProfile?: number;
  /** Dolby Vision base-layer compatibility: 1 HDR10, 2 SDR, 4 HLG. */
  doviBlCompatId?: number;
  /** Audio only. */
  channels?: number;
  channelLayout?: string;
  /** Hz. */
  samplingRate?: number;
}

export interface MediaPart {
  id: number;
  key: string;
  file?: string;
  size?: number;
  container?: string;
  streams: MediaStream[];
}

export interface MediaVersion {
  id: number;
  videoResolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  container?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  duration?: number;
  parts: MediaPart[];
}

/** Milliseconds, as the server reports them. */
export interface Marker {
  kind: 'intro' | 'credits';
  start: number;
  end: number;
}

export interface CastMember {
  name: string;
  role?: string;
  thumb?: string;
}

export interface MediaItem {
  serverId: string;
  ratingKey: string;
  type: ItemType;
  title: string;
  year?: number;
  summary?: string;
  tagline?: string;
  thumb?: string;
  art?: string;
  logo?: string;
  ultraBlur?: UltraBlur;
  contentRating?: string;
  audienceRating?: number;
  studio?: string;
  duration?: number;
  viewOffset?: number;
  viewCount?: number;
  lastViewedAt?: number;
  addedAt?: number;
  originallyAvailableAt?: string;
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  parentRatingKey?: string;
  parentThumb?: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  grandparentThumb?: string;
  grandparentArt?: string;
  leafCount?: number;
  viewedLeafCount?: number;
  childCount?: number;
  /** The section (library) the item belongs to on its server. */
  librarySectionId?: string;
  genres: string[];
  directors: string[];
  cast: CastMember[];
  media: MediaVersion[];
  /** Only on full items (fetchItem). */
  markers: Marker[];
}

export interface LibrarySection {
  serverId: string;
  key: string;
  type: 'movie' | 'show' | 'mixed';
  title: string;
  isWebDav?: boolean;
}

/** Identifies a library across servers, as `${serverId}/${sectionKey}` (see Settings). */
export function libraryId(of: LibrarySection | MediaItem): string {
  return 'key' in of ? `${of.serverId}/${of.key}` : `${of.serverId}/${of.librarySectionId ?? ''}`;
}

type Tag = { tag?: string; role?: string; thumb?: string };

export interface RawMetadata {
  ratingKey?: string | number;
  type?: string;
  title?: string;
  year?: number;
  summary?: string;
  tagline?: string;
  thumb?: string;
  art?: string;
  Image?: { type?: string; url?: string }[];
  UltraBlurColors?: Partial<UltraBlur>;
  contentRating?: string;
  audienceRating?: number;
  studio?: string;
  duration?: number;
  viewOffset?: number;
  viewCount?: number;
  lastViewedAt?: number;
  addedAt?: number;
  originallyAvailableAt?: string;
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  parentRatingKey?: string | number;
  parentThumb?: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string | number;
  grandparentThumb?: string;
  grandparentArt?: string;
  leafCount?: number;
  viewedLeafCount?: number;
  childCount?: number;
  librarySectionID?: string | number;
  Genre?: Tag[];
  Director?: Tag[];
  Role?: Tag[];
  Media?: RawMedia[];
  Marker?: { type?: string; startTimeOffset?: number; endTimeOffset?: number }[];
}

interface RawStream {
  id: number;
  streamType: number;
  index?: number;
  selected?: boolean;
  codec?: string;
  languageTag?: string;
  languageCode?: string;
  language?: string;
  title?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  default?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
  key?: string;
  profile?: string;
  bitrate?: number;
  bitDepth?: number;
  level?: number | string;
  width?: number;
  height?: number;
  frameRate?: number;
  scanType?: string;
  refFrames?: number;
  colorPrimaries?: string;
  colorSpace?: string;
  colorTrc?: string;
  colorRange?: string;
  chromaSubsampling?: string;
  chromaLocation?: string;
  DOVIPresent?: boolean;
  DOVIProfile?: number;
  DOVIBLCompatID?: number;
  channels?: number;
  audioChannelLayout?: string;
  samplingRate?: number;
}

interface RawMedia {
  id: number;
  videoResolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  container?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  duration?: number;
  Part?: { id: number; key: string; file?: string; size?: number; container?: string; Stream?: RawStream[] }[];
}

const ITEM_TYPES = new Set<ItemType>(['movie', 'show', 'season', 'episode', 'collection', 'clip']);
const STREAM_KINDS = { 1: 'video', 2: 'audio', 3: 'subtitle' } as const;

const tags = (list?: Tag[]) => (list ?? []).flatMap((tag) => (tag.tag ? [tag.tag] : []));
const str = (value?: string | number) => (value === undefined || value === null ? undefined : String(value));

function parseStream(raw: RawStream): MediaStream | null {
  const kind = STREAM_KINDS[raw.streamType as keyof typeof STREAM_KINDS];
  if (!kind) return null;
  const level = Number(raw.level);
  return {
    id: raw.id,
    kind,
    codec: raw.codec,
    language: raw.languageTag ?? raw.languageCode ?? raw.language,
    languageName: raw.language,
    title: raw.extendedDisplayTitle ?? raw.displayTitle ?? raw.codec ?? '',
    name: raw.title,
    index: raw.key ? undefined : raw.index,
    selected: Boolean(raw.selected),
    key: raw.key,
    default: Boolean(raw.default),
    forced: Boolean(raw.forced),
    external: Boolean(raw.key),
    hearingImpaired: Boolean(raw.hearingImpaired),
    profile: raw.profile,
    bitrate: raw.bitrate,
    bitDepth: raw.bitDepth,
    level: Number.isFinite(level) && level > 0 ? level : undefined,
    width: raw.width,
    height: raw.height,
    frameRate: raw.frameRate,
    scanType: raw.scanType,
    refFrames: raw.refFrames,
    colorPrimaries: raw.colorPrimaries,
    colorSpace: raw.colorSpace,
    colorTrc: raw.colorTrc,
    colorRange: raw.colorRange,
    chromaSubsampling: raw.chromaSubsampling,
    chromaLocation: raw.chromaLocation,
    dolbyVision: Boolean(raw.DOVIPresent || raw.DOVIProfile),
    doviProfile: raw.DOVIProfile,
    doviBlCompatId: raw.DOVIBLCompatID,
    channels: raw.channels,
    channelLayout: raw.audioChannelLayout,
    samplingRate: raw.samplingRate,
  };
}

function parseMedia(raw: RawMedia): MediaVersion {
  return {
    id: raw.id,
    videoResolution: raw.videoResolution,
    videoCodec: raw.videoCodec,
    audioCodec: raw.audioCodec,
    audioChannels: raw.audioChannels,
    container: raw.container,
    bitrate: raw.bitrate,
    width: raw.width,
    height: raw.height,
    duration: raw.duration,
    parts: (raw.Part ?? []).map((part) => ({
      id: part.id,
      key: part.key,
      file: part.file,
      size: part.size,
      container: part.container,
      streams: (part.Stream ?? []).flatMap((stream) => parseStream(stream) ?? []),
    })),
  };
}

export function parseItem(serverId: string, raw: RawMetadata): MediaItem {
  const blur = raw.UltraBlurColors;
  const type = (raw.type ?? 'other') as ItemType;
  return {
    serverId,
    ratingKey: String(raw.ratingKey ?? ''),
    type: ITEM_TYPES.has(type) ? type : 'other',
    title: raw.title ?? '',
    year: raw.year,
    summary: raw.summary || undefined,
    tagline: raw.tagline || undefined,
    thumb: raw.thumb,
    art: raw.art,
    logo: raw.Image?.find((image) => image.type === 'clearLogo')?.url,
    ultraBlur:
      blur?.topLeft && blur.topRight && blur.bottomRight && blur.bottomLeft
        ? { topLeft: blur.topLeft, topRight: blur.topRight, bottomRight: blur.bottomRight, bottomLeft: blur.bottomLeft }
        : undefined,
    contentRating: raw.contentRating,
    audienceRating: raw.audienceRating,
    studio: raw.studio,
    duration: raw.duration,
    viewOffset: raw.viewOffset,
    viewCount: raw.viewCount,
    lastViewedAt: raw.lastViewedAt,
    addedAt: raw.addedAt,
    originallyAvailableAt: raw.originallyAvailableAt,
    index: raw.index,
    parentIndex: raw.parentIndex,
    parentTitle: raw.parentTitle,
    parentRatingKey: str(raw.parentRatingKey),
    parentThumb: raw.parentThumb,
    grandparentTitle: raw.grandparentTitle,
    grandparentRatingKey: str(raw.grandparentRatingKey),
    grandparentThumb: raw.grandparentThumb,
    grandparentArt: raw.grandparentArt,
    leafCount: raw.leafCount,
    viewedLeafCount: raw.viewedLeafCount,
    childCount: raw.childCount,
    librarySectionId: str(raw.librarySectionID),
    genres: tags(raw.Genre),
    directors: tags(raw.Director),
    cast: (raw.Role ?? []).flatMap((role) => (role.tag ? [{ name: role.tag, role: role.role, thumb: role.thumb }] : [])),
    media: (raw.Media ?? []).map(parseMedia),
    markers: (raw.Marker ?? []).flatMap((marker): Marker[] =>
      (marker.type === 'intro' || marker.type === 'credits') &&
      marker.startTimeOffset !== undefined &&
      marker.endTimeOffset !== undefined &&
      marker.endTimeOffset > marker.startTimeOffset
        ? [{ kind: marker.type, start: marker.startTimeOffset, end: marker.endTimeOffset }]
        : [],
    ),
  };
}

interface Container {
  MediaContainer?: {
    size?: number;
    totalSize?: number;
    Metadata?: RawMetadata[];
    Hub?: { hubIdentifier?: string; type?: string; Metadata?: RawMetadata[] }[];
    Directory?: { key?: string; type?: string; title?: string }[];
  };
}

function get(context: PlexContext, server: LibraryServer, path: string, options: RequestOptions = {}) {
  return requestJson<Container>(context, `${server.baseUrl}${path}`, { token: server.token, ...options });
}

/** In-progress items and next episodes, honouring the server's On Deck window. */
export async function fetchContinueWatching(context: PlexContext, server: LibraryServer, count = 20, signal?: AbortSignal) {
  if (server.kind === 'webdav') return getWebDavContinueWatching(server.id, count);
  const response = await get(context, server, `/hubs?identifier=home.continue,home.ondeck&count=${count}`, { signal });
  return (response.MediaContainer?.Hub ?? []).flatMap((hub) => (hub.Metadata ?? []).map((raw) => parseItem(server.id, raw)));
}

/** type 1 is movies; type 2 returns recently added episodes and seasons. */
export async function fetchRecentlyAdded(
  context: PlexContext,
  server: LibraryServer,
  type: 1 | 2,
  count = 30,
  signal?: AbortSignal,
) {
  if (server.kind === 'webdav') return getWebDavRecentlyAdded(server.id, type, count);
  const response = await get(context, server, `/hubs/home/recentlyAdded?type=${type}&count=${count}`, { signal });
  const container = response.MediaContainer;
  const raws = container?.Metadata ?? (container?.Hub ?? []).flatMap((hub) => hub.Metadata ?? []);
  return raws.map((raw) => parseItem(server.id, raw));
}

export async function fetchSections(context: PlexContext, server: LibraryServer, signal?: AbortSignal) {
  if (server.kind === 'webdav') return getWebDavSections(server.id);
  const response = await get(context, server, '/library/sections', { signal });
  return (response.MediaContainer?.Directory ?? []).flatMap((directory): LibrarySection[] =>
    directory.key && directory.title && (directory.type === 'movie' || directory.type === 'show')
      ? [{ serverId: server.id, key: directory.key, type: directory.type, title: directory.title }]
      : [],
  );
}

/** Plex sort keys; shows order "date added" by their newest episode, as Plex Web does. */
function sortParam(sort: LibrarySort, type: LibrarySection['type']): string {
  switch (sort) {
    case 'title':
      return 'titleSort';
    case 'added':
      return type === 'show' ? 'episode.addedAt:desc' : 'addedAt:desc';
    case 'released':
      return 'originallyAvailableAt:desc';
    case 'rating':
      return 'audienceRating:desc';
    case 'watched':
      return 'lastViewedAt:desc';
  }
}

export async function fetchSectionPage(
  context: PlexContext,
  server: LibraryServer,
  section: LibrarySection,
  start: number,
  size: number,
  sort: LibrarySort = 'title',
  signal?: AbortSignal,
): Promise<{ items: MediaItem[]; totalSize: number }> {
  if (server.kind === 'webdav') return getWebDavSectionPage(server.id, start, size, sort);
  const type = section.type === 'movie' ? 1 : 2;
  const params = new URLSearchParams({
    type: String(type),
    sort: sortParam(sort, section.type),
    'X-Plex-Container-Start': String(start),
    'X-Plex-Container-Size': String(size),
  });
  const response = await get(context, server, `/library/sections/${section.key}/all?${params}`, { signal });
  const container = response.MediaContainer;
  const items = (container?.Metadata ?? []).map((raw) => parseItem(server.id, raw));
  return { items, totalSize: container?.totalSize ?? container?.size ?? items.length };
}

export async function fetchItem(context: PlexContext, server: LibraryServer, ratingKey: string, signal?: AbortSignal) {
  if (server.kind === 'webdav') return getWebDavItem(server.id, ratingKey);
  const response = await get(context, server, `/library/metadata/${ratingKey}?includeMarkers=1`, { signal });
  const raw = response.MediaContainer?.Metadata?.[0];
  if (!raw) throw new Error(`item ${ratingKey} not found`);
  return parseItem(server.id, raw);
}

/** Seasons of a show, or episodes of a season. */
export async function fetchChildren(context: PlexContext, server: LibraryServer, ratingKey: string, signal?: AbortSignal) {
  if (server.kind === 'webdav') return getWebDavChildren(server.id, ratingKey);
  const response = await get(context, server, `/library/metadata/${ratingKey}/children`, { signal });
  return (response.MediaContainer?.Metadata ?? []).map((raw) => parseItem(server.id, raw));
}

const SEARCHABLE = new Set<ItemType>(['movie', 'show', 'episode']);

export async function searchServer(
  context: PlexContext,
  server: LibraryServer,
  query: string,
  limit = 20,
  signal?: AbortSignal,
) {
  if (server.kind === 'webdav') return searchWebDav(server.id, query, limit);
  const params = new URLSearchParams({ query, limit: String(limit), includeCollections: '0' });
  const response = await get(context, server, `/hubs/search?${params}`, { signal });
  return (response.MediaContainer?.Hub ?? [])
    .flatMap((hub) => hub.Metadata ?? [])
    .map((raw) => parseItem(server.id, raw))
    .filter((item) => SEARCHABLE.has(item.type));
}

export async function setWatched(context: PlexContext, server: LibraryServer, ratingKey: string, watched: boolean) {
  if (server.kind === 'webdav') {
    setWebDavWatched(server.id, ratingKey, watched);
    return;
  }
  const action = watched ? 'scrobble' : 'unscrobble';
  const params = new URLSearchParams({ key: ratingKey, identifier: 'com.plexapp.plugins.library' });
  await get(context, server, `/:/${action}?${params}`);
}

/** Server-side resized image, sized in physical pixels. Tokens go in the query because <img> has no headers. */
export function imageUrl(server: LibraryServer, path: string, width: number, height: number, scale = 1): string {
  if (/^https?:\/\//i.test(path) || path.startsWith('playdeck://')) return path;
  if (server.kind === 'webdav') return webdavImageProxyUrl(server.id, server.baseUrl, path);
  const params = new URLSearchParams({
    width: String(Math.round(width * scale)),
    height: String(Math.round(height * scale)),
    minSize: '1',
    upscale: '1',
    url: path,
    'X-Plex-Token': server.token,
  });
  return `${server.baseUrl}/photo/:/transcode?${params}`;
}
