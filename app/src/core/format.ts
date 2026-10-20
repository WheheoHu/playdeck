import type { MediaItem, MediaStream } from './plex/library';

export function formatDuration(ms: number | undefined): string | undefined {
  if (!ms) return undefined;
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function formatBytes(bytes: number | undefined): string | undefined {
  if (!bytes) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit >= 3 ? 2 : 0)} ${units[unit]}`;
}

export function formatBitrate(kbps: number | undefined): string | undefined {
  if (!kbps) return undefined;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}

/** "S2 · E5" for episodes, "S2" for seasons. */
export function episodeLabel(item: MediaItem): string | undefined {
  if (item.type === 'episode' && item.parentIndex !== undefined && item.index !== undefined) {
    return `S${item.parentIndex} · E${item.index}`;
  }
  if (item.type === 'season' && item.index !== undefined) return `S${item.index}`;
  return undefined;
}

/** The video's HDR format, or undefined for SDR. */
export function dynamicRange(video: MediaStream | undefined): string | undefined {
  const title = video?.title ?? '';
  if (/dovi|dolby vision/i.test(title) || video?.dolbyVision) return /hdr10\+/i.test(title) ? 'Dolby Vision · HDR10+' : 'Dolby Vision';
  if (/hdr10\+/i.test(title)) return 'HDR10+';
  if (/\bhlg/i.test(title) || video?.colorTrc === 'arib-std-b67') return 'HLG';
  if (/\bhdr/i.test(title) || video?.colorTrc === 'smpte2084') return 'HDR10';
  return undefined;
}

/** Plex's "4k", "1080", "sd" as "4K", "1080p", "SD". */
export function resolutionLabel(resolution: string | undefined): string | undefined {
  if (!resolution) return undefined;
  return resolution === '4k' ? '4K' : /^\d+$/.test(resolution) ? `${resolution}p` : resolution.toUpperCase();
}

/** Badges like "4K", "Dolby Vision", "Atmos" for the item's first version. */
export function qualityBadges(item: MediaItem): string[] {
  const version = item.media[0];
  if (!version) return [];
  const streams = version.parts.flatMap((part) => part.streams);
  const badges: string[] = [];
  const resolution = resolutionLabel(version.videoResolution);
  if (resolution) badges.push(resolution);
  const range = dynamicRange(streams.find((stream) => stream.kind === 'video'));
  if (range) badges.push(range);
  if (streams.some((stream) => stream.kind === 'audio' && /atmos/i.test(stream.title))) badges.push('Atmos');
  return badges;
}
