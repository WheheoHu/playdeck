import type { CastMember, MediaStream, MediaVersion } from '../plex/library';
import { type WebDavEntry, decodeXmlEntities } from './client';

const VIDEO_EXTS = new Set(['mkv', 'mp4', 'm4v', 'avi', 'mov', 'ts', 'm2ts', 'webm', 'wmv', 'flv', 'iso']);
const SUBTITLE_EXTS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'sup']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTS.has(extOf(name));
}

export function isSubtitleFile(name: string): boolean {
  return SUBTITLE_EXTS.has(extOf(name));
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}

export interface ParsedNfo {
  kind?: 'movie' | 'tvshow' | 'episodedetails';
  title?: string;
  year?: number;
  summary?: string;
  tagline?: string;
  contentRating?: string;
  audienceRating?: number;
  studio?: string;
  /** Milliseconds. */
  duration?: number;
  originallyAvailableAt?: string;
  season?: number;
  episode?: number;
  genres: string[];
  directors: string[];
  cast: CastMember[];
}

function firstTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return undefined;
  const text = decodeXmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
  return text || undefined;
}

function allTags(xml: string, tag: string): string[] {
  const matches = xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'));
  const result: string[] = [];
  for (const match of matches) {
    const text = decodeXmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function parseRating(xml: string): number | undefined {
  const nested = xml.match(/<rating\b[^>]*>[\s\S]*?<value\b[^>]*>([\d.]+)<\/value>/i);
  if (nested) {
    const val = Number(nested[1]);
    if (Number.isFinite(val) && val > 0) return val;
  }
  const direct = firstTag(xml, 'rating');
  if (direct && /^[\d.]+$/.test(direct)) {
    const val = Number(direct);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return undefined;
}

/** Parses Kodi / Jellyfin / Emby / TinyMediaManager `.nfo` XML files. */
export function parseNfo(xml: string): ParsedNfo {
  const kind = /<episodedetails\b/i.test(xml)
    ? 'episodedetails'
    : /<tvshow\b/i.test(xml)
      ? 'tvshow'
      : /<movie\b/i.test(xml)
        ? 'movie'
        : undefined;

  const title = firstTag(xml, 'title') ?? firstTag(xml, 'originaltitle');
  const dateText = firstTag(xml, 'premiered') ?? firstTag(xml, 'releasedate') ?? firstTag(xml, 'aired');
  const yearTag = firstTag(xml, 'year');
  const yearNum = yearTag ? Number(yearTag) : dateText ? Number(dateText.slice(0, 4)) : Number.NaN;
  const year = Number.isFinite(yearNum) && yearNum >= 1880 && yearNum <= 2100 ? yearNum : undefined;

  const summary = firstTag(xml, 'plot') ?? firstTag(xml, 'outline');
  const tagline = firstTag(xml, 'tagline');
  const contentRating = firstTag(xml, 'mpaa') ?? firstTag(xml, 'certification');
  const audienceRating = parseRating(xml);
  const studio = firstTag(xml, 'studio');

  const runtimeTag = firstTag(xml, 'runtime');
  const runtimeMinutes = runtimeTag ? Number(runtimeTag.replace(/[^\d.]/g, '')) : Number.NaN;
  const duration = Number.isFinite(runtimeMinutes) && runtimeMinutes > 0 ? Math.round(runtimeMinutes * 60_000) : undefined;

  const seasonNum = Number(firstTag(xml, 'season'));
  const episodeNum = Number(firstTag(xml, 'episode'));
  const season = Number.isFinite(seasonNum) && seasonNum >= 0 ? seasonNum : undefined;
  const episode = Number.isFinite(episodeNum) && episodeNum >= 0 ? episodeNum : undefined;

  const genres = allTags(xml, 'genre');
  const directors = allTags(xml, 'director');
  const cast: CastMember[] = [];
  for (const match of xml.matchAll(/<actor\b[^>]*>([\s\S]*?)<\/actor>/gi)) {
    const block = match[1];
    const name = firstTag(block, 'name');
    if (!name) continue;
    const role = firstTag(block, 'role');
    const thumb = firstTag(block, 'thumb');
    cast.push({ name, role, thumb: thumb && /^https?:\/\//i.test(thumb) ? thumb : undefined });
  }

  return {
    kind,
    title,
    year,
    summary,
    tagline,
    contentRating,
    audienceRating,
    studio,
    duration,
    originallyAvailableAt: dateText,
    season,
    episode,
    genres,
    directors,
    cast,
  };
}

export interface FilenameMetadata {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  videoResolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  dolbyVision: boolean;
  doviProfile?: number;
  colorTrc?: string;
}

const RELEASE_NOISE =
  /\b(2160p|1080p|720p|480p|4k|uhd|blu-?ray|bdrip|brrip|remux|web-?dl|webrip|hdtv|dv|dovi|dolby\.?vision|hdr10\+?|hdr|hlg|sdr|hevc|x265|h\.?265|avc|x264|h\.?264|av1|10bit|8bit|truehd|atmos|dts-?hd|dts-?x|dts|ddp\d*|eac3|ac3\d*|aac\d*|flac\d*|proper|repack|internal)\b.*$/i;

function cleanTitle(raw: string): string {
  const withoutBrackets = raw
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/\[[^\]]*(?:1080|2160|720|x264|x265|hevc|avc|bdrip|web|aac|flac)[^\]]*\]/gi, '');
  const dotted = withoutBrackets.replace(/[._]+/g, ' ').trim();
  const stripped = dotted.replace(RELEASE_NOISE, '').replace(/[\s([\-–—]+$/, '').trim();
  return stripped || dotted || raw;
}

/** Extracts title, year, season/episode numbers and technical stream hints from a filename or folder name. */
export function parseFilenameMetadata(name: string, isFolder = false): FilenameMetadata {
  const stem = isFolder ? name : stemOf(name);
  const lower = stem.toLowerCase();

  let season: number | undefined;
  let episode: number | undefined;
  let titlePart = stem;
  let episodeTitle: string | undefined;

  // Standard S01E02 / 1x02 pattern
  const seMatch =
    stem.match(/^(.*?)[.\s_-]*\bS(\d{1,2})[.\s_-]*E(\d{1,3})\b(?:[.\s_-]*E\d{1,3}\b)*(?:[.\s_-]+(.*))?$/i) ??
    stem.match(/^(.*?)[.\s_-]*\b(\d{1,2})x(\d{2,3})\b(?:[.\s_-]+(.*))?$/i);
  if (seMatch) {
    titlePart = seMatch[1] || stem;
    season = Number(seMatch[2]);
    episode = Number(seMatch[3]);
    if (seMatch[4]) {
      const cleanedEp = cleanTitle(seMatch[4]);
      if (cleanedEp && !/^\d+$/.test(cleanedEp)) episodeTitle = cleanedEp;
    }
  } else if (!isFolder) {
    // Episode-only patterns inside a show/season folder: "EP03", "E03", "第03集", " - 03 "
    const epOnly =
      stem.match(/^(.*?)[.\s_-]*\bE(?:P)?(\d{1,3})\b(?:[.\s_-]+(.*))?$/i) ??
      stem.match(/^(.*?)[.\s_-]*第\s*(\d{1,3})\s*[集话話期](?:[.\s_-]+(.*))?$/i) ??
      stem.match(/^(.*?)\s+-\s+(\d{1,3})(?:\s+(.*))?$/);
    if (epOnly && Number(epOnly[2]) < 1900) {
      titlePart = epOnly[1] || stem;
      season = 1;
      episode = Number(epOnly[2]);
      if (epOnly[3]) {
        const cleanedEp = cleanTitle(epOnly[3]);
        if (cleanedEp) episodeTitle = cleanedEp;
      }
    }
  }

  // Strip release tags first, then extract the trailing year token (so titles like "Blade Runner 2049 (2017)" or "1917.2019" keep their title number).
  const strippedPart = titlePart.replace(RELEASE_NOISE, '').replace(/[.\s_-]+$/, '');
  let year: number | undefined;
  const yearMatches = [...strippedPart.matchAll(/(?:[([]|[.\s_-])(19\d{2}|20[0-3]\d)(?:[)\]]|[.\s_-]|$)/g)];
  const lastYear = yearMatches.at(-1);
  if (lastYear && lastYear.index !== undefined && lastYear.index > 0) {
    year = Number(lastYear[1]);
    titlePart = strippedPart.slice(0, lastYear.index);
  } else {
    titlePart = strippedPart;
  }

  const title = cleanTitle(titlePart);

  const videoResolution = /\b(2160p|4k|uhd)\b/i.test(lower)
    ? '4k'
    : /\b1080p\b/i.test(lower)
      ? '1080'
      : /\b720p\b/i.test(lower)
        ? '720'
        : undefined;

  const videoCodec = /\b(hevc|x265|h\.?265)\b/i.test(lower)
    ? 'hevc'
    : /\b(avc|x264|h\.?264)\b/i.test(lower)
      ? 'h264'
      : /\bav1\b/i.test(lower)
        ? 'av1'
        : undefined;

  const audioCodec = /\btruehd\b/i.test(lower)
    ? 'truehd'
    : /\bdts-?hd\b/i.test(lower)
      ? 'dca-ma'
      : /\bdts\b/i.test(lower)
        ? 'dca'
        : /\b(eac3|ddp\d*|dd\+)/i.test(lower)
          ? 'eac3'
          : /\bac3\d*\b/i.test(lower)
            ? 'ac3'
            : /\bflac\d*\b/i.test(lower)
              ? 'flac'
              : /\baac\d*\b/i.test(lower)
                ? 'aac'
                : undefined;

  const dolbyVision = /\b(dovi|dv|dolby\.?vision)\b/i.test(lower);
  const doviProfileMatch = lower.match(/\b(?:dv|dovi)\.?(?:p|profile\.?)?([578])\b/);
  const doviProfile = doviProfileMatch ? Number(doviProfileMatch[1]) : dolbyVision ? 8 : undefined;
  const isHdr = /\b(hdr10\+?|hdr)\b/i.test(lower);
  const isHlg = /\bhlg\b/i.test(lower);
  const colorTrc = isHdr || dolbyVision ? 'smpte2084' : isHlg ? 'arib-std-b67' : undefined;

  return {
    title,
    year,
    season,
    episode,
    episodeTitle,
    videoResolution,
    videoCodec,
    audioCodec,
    dolbyVision,
    doviProfile,
    colorTrc,
  };
}

/** Detects season number from a season folder name such as "Season 1", "S02", "Specials", "第1季". */
export function parseSeasonFolderNumber(folderName: string): number | undefined {
  if (/^(specials|ova|sp|season\s*0+|s0+)$/i.test(folderName.trim())) return 0;
  const match =
    folderName.match(/\b(?:season|s)\s*(\d{1,2})\b/i) ??
    folderName.match(/第\s*(\d{1,2})\s*季/);
  return match ? Number(match[1]) : undefined;
}

export interface FolderArtwork {
  poster?: string;
  art?: string;
  logo?: string;
}

/** Finds folder-level or file-specific artwork in a directory's entry list. */
export function findArtwork(entries: WebDavEntry[], videoName?: string): FolderArtwork {
  const images = entries.filter((entry) => !entry.isDirectory && isImageFile(entry.name));
  if (images.length === 0) return {};

  const byStem = new Map(images.map((img) => [stemOf(img.name).toLowerCase(), img.path]));
  const videoStem = videoName ? stemOf(videoName).toLowerCase() : undefined;

  const pick = (candidates: string[]) => {
    for (const candidate of candidates) {
      const hit = byStem.get(candidate);
      if (hit) return hit;
    }
    return undefined;
  };

  const poster = pick([
    ...(videoStem ? [`${videoStem}-poster`, `${videoStem}-thumb`, videoStem] : []),
    'poster',
    'folder',
    'cover',
    'default',
    'movie',
    'show',
  ]);
  const art = pick([
    ...(videoStem ? [`${videoStem}-fanart`, `${videoStem}-backdrop`] : []),
    'fanart',
    'backdrop',
    'art',
    'background',
  ]);
  const logo = pick([...(videoStem ? [`${videoStem}-clearlogo`, `${videoStem}-logo`] : []), 'clearlogo', 'logo']);

  return { poster, art, logo };
}

function parseSubtitleSuffix(suffix: string): { language?: string; title: string; forced: boolean; sdh: boolean } {
  const clean = suffix.replace(/^[._-]+/, '');
  if (!clean) return { title: 'External', forced: false, sdh: false };
  const lower = clean.toLowerCase();
  const forced = /\bforced\b|强制/.test(lower);
  const sdh = /\bsdh\b|听障/.test(lower);

  let language: string | undefined;
  let label = clean;
  if (/\b(chs|sc|zh-cn|zh-hans|simplified)\b|简体|简中/.test(lower)) {
    language = 'zh-Hans';
    label = '简体中文';
  } else if (/\b(cht|tc|zh-tw|zh-hk|zh-hant|traditional)\b|繁体|繁體|繁中/.test(lower)) {
    language = 'zh-Hant';
    label = '繁體中文';
  } else if (/\b(zh|zho|chi|chinese)\b|中文/.test(lower)) {
    language = 'zh';
    label = '中文';
  } else if (/\b(en|eng|english)\b/.test(lower)) {
    language = 'en';
    label = 'English';
  } else if (/\b(ja|jpn|japanese)\b|日本語|日语/.test(lower)) {
    language = 'ja';
    label = '日本語';
  } else if (/\b(ko|kor|korean)\b|한국어|韩语/.test(lower)) {
    language = 'ko';
    label = '한국어';
  }
  return { language, title: label, forced, sdh };
}

/** Finds sidecar subtitle files matching `videoName` in the same directory. */
export function matchSubtitles(videoName: string, entries: WebDavEntry[], idBase = 1000): MediaStream[] {
  const videoStem = stemOf(videoName);
  const videoStemLower = videoStem.toLowerCase();
  const subtitles = entries.filter((entry) => !entry.isDirectory && isSubtitleFile(entry.name));
  const allVideos = entries.filter((entry) => !entry.isDirectory && isVideoFile(entry.name));

  const matched: MediaStream[] = [];
  let nextId = idBase;

  for (const sub of subtitles) {
    const subStem = stemOf(sub.name);
    const subStemLower = subStem.toLowerCase();
    const startsWithVideo =
      subStemLower === videoStemLower ||
      subStemLower.startsWith(`${videoStemLower}.`) ||
      subStemLower.startsWith(`${videoStemLower}_`) ||
      subStemLower.startsWith(`${videoStemLower}-`);

    // If there is only 1 video file in the folder, also attach any generic subtitle in the folder.
    if (!startsWithVideo && allVideos.length !== 1) continue;

    const suffix = startsWithVideo ? subStem.slice(videoStem.length) : subStem;
    const { language, title, forced, sdh } = parseSubtitleSuffix(suffix);
    const codec = extOf(sub.name);

    matched.push({
      id: nextId++,
      kind: 'subtitle',
      codec,
      language,
      languageName: title,
      title: `${title} (${codec.toUpperCase()})`,
      name: suffix.replace(/^[._-]+/, '') || undefined,
      selected: false,
      key: sub.path,
      default: false,
      forced,
      external: true,
      hearingImpaired: sdh,
      dolbyVision: false,
    });
  }
  return matched;
}

/** Builds a `MediaVersion` for a WebDAV video file, combining filename codec/HDR hints and external subtitles. */
export function buildWebDavMediaVersion(
  videoEntry: WebDavEntry,
  meta: FilenameMetadata,
  durationMs: number | undefined,
  subtitles: MediaStream[],
  idSeed = 1,
): MediaVersion {
  const container = extOf(videoEntry.name) || undefined;
  const bitrate =
    videoEntry.size && durationMs && durationMs > 0
      ? Math.round((videoEntry.size * 8) / durationMs)
      : undefined;

  const streams: MediaStream[] = [];
  if (meta.videoCodec || meta.videoResolution || meta.dolbyVision || meta.colorTrc) {
    streams.push({
      id: idSeed * 10 + 1,
      kind: 'video',
      codec: meta.videoCodec,
      title: [
        meta.videoResolution === '4k' ? '4K' : meta.videoResolution ? `${meta.videoResolution}p` : undefined,
        meta.dolbyVision ? 'Dolby Vision' : meta.colorTrc === 'smpte2084' ? 'HDR10' : undefined,
        meta.videoCodec?.toUpperCase(),
      ]
        .filter(Boolean)
        .join(' '),
      selected: true,
      default: true,
      forced: false,
      external: false,
      hearingImpaired: false,
      width: meta.videoResolution === '4k' ? 3840 : meta.videoResolution === '1080' ? 1920 : meta.videoResolution === '720' ? 1280 : undefined,
      height: meta.videoResolution === '4k' ? 2160 : meta.videoResolution === '1080' ? 1080 : meta.videoResolution === '720' ? 720 : undefined,
      colorTrc: meta.colorTrc,
      dolbyVision: meta.dolbyVision,
      doviProfile: meta.doviProfile,
    });
  }
  if (meta.audioCodec) {
    streams.push({
      id: idSeed * 10 + 2,
      kind: 'audio',
      codec: meta.audioCodec,
      title: meta.audioCodec.toUpperCase(),
      selected: true,
      default: true,
      forced: false,
      external: false,
      hearingImpaired: false,
      dolbyVision: false,
    });
  }
  streams.push(...subtitles);

  return {
    id: idSeed,
    videoResolution: meta.videoResolution,
    videoCodec: meta.videoCodec,
    audioCodec: meta.audioCodec,
    container,
    bitrate,
    width: meta.videoResolution === '4k' ? 3840 : meta.videoResolution === '1080' ? 1920 : meta.videoResolution === '720' ? 1280 : undefined,
    height: meta.videoResolution === '4k' ? 2160 : meta.videoResolution === '1080' ? 1080 : meta.videoResolution === '720' ? 720 : undefined,
    duration: durationMs,
    parts: [
      {
        id: idSeed * 100,
        key: videoEntry.path,
        file: videoEntry.path,
        size: videoEntry.size,
        container,
        streams,
      },
    ],
  };
}

/**
 * Classifies a top-level folder in a Mixed (`type: 'mixed'`) WebDAV library as `'show'` or `'movie'`
 * by inspecting its immediate children.
 */
export function classifyMixedFolder(folderEntry: WebDavEntry, children: WebDavEntry[]): 'movie' | 'show' {
  const namesLower = new Set(children.filter((c) => !c.isDirectory).map((c) => c.name.toLowerCase()));
  if (namesLower.has('tvshow.nfo')) return 'show';
  if (namesLower.has('movie.nfo')) return 'movie';

  const subdirs = children.filter((c) => c.isDirectory);
  if (subdirs.some((dir) => parseSeasonFolderNumber(dir.name) !== undefined)) return 'show';

  const videos = children.filter((c) => !c.isDirectory && isVideoFile(c.name));
  if (videos.length >= 2) return 'show';
  if (videos.some((v) => parseFilenameMetadata(v.name).episode !== undefined)) return 'show';
  if (parseSeasonFolderNumber(folderEntry.name) !== undefined) return 'show';

  return 'movie';
}
