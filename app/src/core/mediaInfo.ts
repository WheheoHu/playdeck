import { dynamicRange, formatBitrate, formatBytes, formatDuration, resolutionLabel } from './format';
import type { MessageKey, Translate } from './i18n';
import type { MediaStream, MediaVersion } from './plex/library';

/** One track as shown under a detail page. */
export interface TrackInfo {
  id: number;
  kind: MediaStream['kind'];
  /** 1-based position among the tracks of its kind, and how many there are. */
  index: number;
  count: number;
  title: string;
  flags: MessageKey[];
  facts: [MessageKey, string][];
}

const KIND_ORDER: MediaStream['kind'][] = ['video', 'audio', 'subtitle'];

const CODECS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  h265: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vc1: 'VC-1',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
  aac: 'AAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
  truehd: 'Dolby TrueHD',
  dca: 'DTS',
  dts: 'DTS',
  flac: 'FLAC',
  alac: 'ALAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  mp3: 'MP3',
  pcm: 'PCM',
  ass: 'ASS',
  ssa: 'SSA',
  srt: 'SRT',
  subrip: 'SRT',
  pgs: 'PGS',
  hdmv_pgs_subtitle: 'PGS',
  vobsub: 'VobSub',
  dvd_subtitle: 'VobSub',
  mov_text: 'MOV Text',
  webvtt: 'WebVTT',
};

const COLORS: Record<string, string> = {
  bt709: 'BT.709',
  bt2020: 'BT.2020',
  bt2020nc: 'BT.2020 NCL',
  bt2020c: 'BT.2020 CL',
  bt470bg: 'BT.470 BG',
  bt470m: 'BT.470 M',
  smpte170m: 'SMPTE 170M',
  smpte240m: 'SMPTE 240M',
  smpte2084: 'PQ (SMPTE 2084)',
  'arib-std-b67': 'HLG (ARIB STD-B67)',
  smpte432: 'Display P3',
};

export function codecName(codec: string | undefined): string | undefined {
  if (!codec) return undefined;
  return CODECS[codec.toLowerCase()] ?? codec.toUpperCase();
}

/** "main 10" → "Main 10", "lc" → "LC", "he-aac" → "HE-AAC". */
function profileName(profile: string | undefined): string | undefined {
  if (!profile) return undefined;
  return profile.replace(/[a-z]+/gi, (word) =>
    word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1),
  );
}

/** Plex passes the encoder's level number: H.264 41 is 4.1, HEVC 153 is 5.1 (×30), AV1 13 is 5.1. */
export function levelName(codec: string | undefined, level: number | undefined): string | undefined {
  if (!level) return undefined;
  const name = codec?.toLowerCase();
  if (name === 'hevc' && level >= 30) return (level / 30).toFixed(1);
  if (name === 'av1' && level < 32) return `${2 + (level >> 2)}.${level & 3}`;
  if (level >= 10) return (level / 10).toFixed(1);
  return String(level);
}

/** "Dolby Vision 8.1", "HDR10+", "HLG" or "SDR". */
export function dynamicRangeName(video: MediaStream): string {
  if (video.dolbyVision) {
    const compat = video.doviBlCompatId ? `.${video.doviBlCompatId}` : '';
    return video.doviProfile !== undefined ? `Dolby Vision ${video.doviProfile}${compat}` : 'Dolby Vision';
  }
  return dynamicRange(video) ?? 'SDR';
}

const number = (value: number) => String(Number(value.toFixed(3)));

function facts(stream: MediaStream, t: Translate): [MessageKey, string][] {
  const list: [MessageKey, string | undefined][] = [['info.language', stream.languageName ?? stream.language]];
  const codec = codecName(stream.codec);
  if (stream.kind === 'video') {
    list.push(
      ['info.codec', codec],
      ['info.profile', profileName(stream.profile)],
      ['info.level', levelName(stream.codec, stream.level)],
      ['info.resolution', stream.width && stream.height ? `${stream.width}×${stream.height}` : undefined],
      ['info.frameRate', stream.frameRate ? `${number(stream.frameRate)} fps` : undefined],
      ['info.bitrate', formatBitrate(stream.bitrate)],
      ['info.dynamicRange', dynamicRangeName(stream)],
      ['info.bitDepth', stream.bitDepth ? `${stream.bitDepth}-bit` : undefined],
      ['info.chroma', stream.chromaSubsampling],
      ['info.colorPrimaries', stream.colorPrimaries && (COLORS[stream.colorPrimaries] ?? stream.colorPrimaries)],
      ['info.colorSpace', stream.colorSpace && (COLORS[stream.colorSpace] ?? stream.colorSpace)],
      ['info.colorTrc', stream.colorTrc && (COLORS[stream.colorTrc] ?? stream.colorTrc)],
      [
        'info.colorRange',
        stream.colorRange === 'tv' ? t('info.rangeLimited') : stream.colorRange === 'pc' ? t('info.rangeFull') : stream.colorRange,
      ],
      ['info.chromaLocation', stream.chromaLocation],
      ['info.refFrames', stream.refFrames ? String(stream.refFrames) : undefined],
      [
        'info.scanType',
        stream.scanType === 'progressive'
          ? t('info.progressive')
          : stream.scanType === 'interlaced'
            ? t('info.interlaced')
            : stream.scanType,
      ],
    );
  } else if (stream.kind === 'audio') {
    const channels = stream.channels ? t('info.channelCount', { count: stream.channels }) : undefined;
    list.push(
      ['info.codec', codec],
      ['info.profile', profileName(stream.profile)],
      ['info.channels', [channels, stream.channelLayout].filter(Boolean).join(' · ') || undefined],
      ['info.sampleRate', stream.samplingRate ? `${number(stream.samplingRate / 1000)} kHz` : undefined],
      ['info.bitDepth', stream.bitDepth ? `${stream.bitDepth}-bit` : undefined],
      ['info.bitrate', formatBitrate(stream.bitrate)],
    );
  } else {
    list.push(['info.codec', codec]);
  }
  return list.filter((fact): fact is [MessageKey, string] => Boolean(fact[1]));
}

/** A version's tracks, video first, then audio, then subtitles, each in the file's order. */
export function trackInfo(version: MediaVersion, t: Translate): TrackInfo[] {
  // Stacked files repeat the same tracks in every part.
  const streams = version.parts.find((part) => part.streams.length > 0)?.streams ?? [];
  return KIND_ORDER.flatMap((kind) => {
    const ofKind = streams.filter((stream) => stream.kind === kind);
    return ofKind.map((stream, i) => ({
      id: stream.id,
      kind,
      index: i + 1,
      count: ofKind.length,
      title: stream.title || codecName(stream.codec) || t(`info.${kind}`),
      flags: (
        [
          [stream.default, 'info.default'],
          [stream.forced, 'info.forced'],
          [stream.hearingImpaired, 'info.sdh'],
          [stream.external, 'info.external'],
        ] as const
      ).flatMap(([on, flag]): MessageKey[] => (on ? [flag] : [])),
      facts: facts(stream, t),
    }));
  });
}

/** "4K · MKV · 58.2 GB · 2h 36m · 52.4 Mbps" for a version's files. */
export function versionSummary(version: MediaVersion): string[] {
  return [
    resolutionLabel(version.videoResolution),
    version.container?.toUpperCase(),
    formatBytes(version.parts.reduce((sum, part) => sum + (part.size ?? 0), 0)),
    formatDuration(version.duration),
    formatBitrate(version.bitrate),
  ].filter((part): part is string => Boolean(part));
}
