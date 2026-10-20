import { describe, expect, it } from 'vitest';
import { translator } from '../src/core/i18n';
import { dynamicRangeName, levelName, trackInfo, versionSummary } from '../src/core/mediaInfo';
import { parseItem } from '../src/core/plex/library';

const t = translator('en');

const EPISODE = parseItem('srv', {
  ratingKey: 300,
  type: 'episode',
  title: 'Switch',
  Media: [
    {
      id: 7,
      videoResolution: '1080',
      container: 'mkv',
      bitrate: 8499,
      duration: 2_820_000,
      Part: [
        {
          id: 70,
          key: '/library/parts/70/file.mkv',
          file: '/media/tv/Better Call Saul/S02E01.mkv',
          size: 3_006_477_107,
          Stream: [
            {
              id: 2,
              streamType: 2,
              codec: 'aac',
              language: 'Japanese',
              languageTag: 'ja',
              extendedDisplayTitle: 'Japanese (AAC Stereo)',
              profile: 'lc',
              channels: 2,
              audioChannelLayout: 'stereo',
              samplingRate: 48000,
              bitrate: 192,
              default: true,
            },
            {
              id: 1,
              streamType: 1,
              codec: 'h264',
              extendedDisplayTitle: '1080p (H.264)',
              profile: 'high',
              level: 40,
              width: 1920,
              height: 1080,
              frameRate: 23.976,
              bitrate: 8307,
              bitDepth: 8,
              colorPrimaries: 'bt709',
              colorRange: 'tv',
              colorTrc: 'bt709',
              chromaSubsampling: '4:2:0',
              scanType: 'progressive',
              refFrames: 4,
            },
            { id: 3, streamType: 2, codec: 'eac3', extendedDisplayTitle: 'English (EAC3 5.1)', channels: 6 },
            {
              id: 4,
              streamType: 3,
              codec: 'srt',
              language: 'English',
              extendedDisplayTitle: 'English SDH (SRT External)',
              hearingImpaired: true,
              key: '/library/streams/4',
            },
          ],
        },
      ],
    },
  ],
});

describe('trackInfo', () => {
  const tracks = trackInfo(EPISODE.media[0], t);

  it('orders video, audio, then subtitles, numbering tracks within their kind', () => {
    expect(tracks.map((track) => [track.kind, track.index, track.count])).toEqual([
      ['video', 1, 1],
      ['audio', 1, 2],
      ['audio', 2, 2],
      ['subtitle', 1, 1],
    ]);
  });

  it('describes video with readable values, skipping what the server did not report', () => {
    expect(Object.fromEntries(tracks[0].facts)).toEqual({
      'info.codec': 'H.264',
      'info.profile': 'High',
      'info.level': '4.0',
      'info.resolution': '1920×1080',
      'info.frameRate': '23.976 fps',
      'info.bitrate': '8.3 Mbps',
      'info.dynamicRange': 'SDR',
      'info.bitDepth': '8-bit',
      'info.chroma': '4:2:0',
      'info.colorPrimaries': 'BT.709',
      'info.colorTrc': 'BT.709',
      'info.colorRange': 'Limited',
      'info.refFrames': '4',
      'info.scanType': 'Progressive',
    });
  });

  it('describes audio and subtitle tracks with their flags', () => {
    expect(tracks[1]).toMatchObject({ title: 'Japanese (AAC Stereo)', flags: ['info.default'] });
    expect(Object.fromEntries(tracks[1].facts)).toEqual({
      'info.language': 'Japanese',
      'info.codec': 'AAC',
      'info.profile': 'LC',
      'info.channels': '2 ch · stereo',
      'info.sampleRate': '48 kHz',
      'info.bitrate': '192 kbps',
    });
    expect(tracks[3].flags).toEqual(['info.sdh', 'info.external']);
  });
  it('summarizes the file', () => {
    expect(versionSummary(EPISODE.media[0])).toEqual(['1080p', 'MKV', '2.80 GB', '47m', '8.5 Mbps']);
  });
});

describe('track values', () => {
  it('reads codec levels the way encoders number them', () => {
    expect(levelName('h264', 41)).toBe('4.1');
    expect(levelName('hevc', 153)).toBe('5.1');
    expect(levelName('av1', 13)).toBe('5.1');
  });

  it('names Dolby Vision profiles and HDR formats', () => {
    const base = EPISODE.media[0].parts[0].streams.find((stream) => stream.kind === 'video')!;
    expect(dynamicRangeName({ ...base, dolbyVision: true, doviProfile: 8, doviBlCompatId: 1 })).toBe('Dolby Vision 8.1');
    expect(dynamicRangeName({ ...base, dolbyVision: true, doviProfile: 5, doviBlCompatId: 0 })).toBe('Dolby Vision 5');
    expect(dynamicRangeName({ ...base, colorTrc: 'smpte2084' })).toBe('HDR10');
    expect(dynamicRangeName({ ...base, colorTrc: 'arib-std-b67' })).toBe('HLG');
  });
});
