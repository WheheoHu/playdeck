import { describe, expect, it } from 'vitest';
import { buildSession, inputConf, playableOf, sessionTracks } from '../src/core/playback';
import { type MediaItem, type RawMetadata, parseItem } from '../src/core/plex/library';
import { fetchNextEpisode, nextEpisodeIn, reportTimeline, selectStreams } from '../src/core/plex/playback';
import { TimelineReporter } from '../src/core/timeline';
import { fakeFetch } from './support';

const SERVER = { id: 'srv', name: 'Home', baseUrl: 'https://plex.example:32400', token: 'secret-token' };
const SETTINGS = { autoSkipMarkers: false, autoplayNext: true };

const EPISODE: RawMetadata = {
  ratingKey: 501,
  type: 'episode',
  title: 'Pilot',
  grandparentTitle: 'Severance',
  grandparentRatingKey: 500,
  parentIndex: 1,
  index: 1,
  duration: 3_000_000,
  viewOffset: 1_200_000,
  Marker: [
    { type: 'intro', startTimeOffset: 60_000, endTimeOffset: 120_000 },
    { type: 'credits', startTimeOffset: 2_900_000, endTimeOffset: 3_000_000 },
    { type: 'commercial', startTimeOffset: 1, endTimeOffset: 2 },
  ],
  Media: [
    {
      id: 7,
      duration: 3_000_000,
      Part: [
        {
          id: 70,
          key: '/library/parts/70/1/file.mkv',
          Stream: [
            { id: 1, streamType: 1, index: 0, codec: 'hevc', frameRate: 23.976 },
            { id: 2, streamType: 2, index: 1, codec: 'eac3', displayTitle: 'English (EAC3 5.1)', languageTag: 'en' },
            { id: 3, streamType: 2, index: 2, codec: 'aac', displayTitle: '日本語 (AAC Stereo)', default: true },
            { id: 4, streamType: 3, index: 3, codec: 'pgs', displayTitle: 'English (PGS)', selected: true },
            { id: 5, streamType: 3, codec: 'srt', displayTitle: '中文 (SRT External)', key: '/library/streams/5' },
          ],
        },
      ],
    },
  ],
};

const episode = (raw: Partial<RawMetadata> = {}): MediaItem => parseItem(SERVER.id, { ...EPISODE, ...raw });

describe('play sessions', () => {
  it('plays the preferred version over Direct Play, with the token in a header only', () => {
    const { context } = fakeFetch([]);
    const session = buildSession(context, SERVER, playableOf(episode())!, { settings: SETTINGS, strings: {} });
    expect(session.url).toBe('https://plex.example:32400/library/parts/70/1/file.mkv');
    expect(session.url).not.toContain('secret-token');
    expect(session.httpHeaders).toContain('X-Plex-Token: secret-token');
    expect(session.httpHeaders.some((header) => header.startsWith('Accept:'))).toBe(false);
    expect(session.frameRate).toBe(23.976);
    expect(session).toMatchObject({ title: 'Severance', subtitle: 'S1 · E1 · Pilot', autoplayNext: true });
  });

  it('resumes from the saved offset unless asked to start over or nearly finished', () => {
    const { context } = fakeFetch([]);
    const options = { settings: SETTINGS, strings: {} };
    expect(buildSession(context, SERVER, playableOf(episode())!, options).start).toBe(1200);
    expect(buildSession(context, SERVER, playableOf(episode())!, { ...options, fromStart: true }).start).toBe(0);
    expect(buildSession(context, SERVER, playableOf(episode({ viewOffset: 2_995_000 }))!, options).start).toBe(0);
  });

  it('maps embedded tracks by stream index and sidecar subtitles by URL', () => {
    const { part } = playableOf(episode())!;
    expect(sessionTracks(part, SERVER)).toEqual([
      { id: 2, kind: 'audio', title: 'English (EAC3 5.1)', language: 'en', ffIndex: 1, selected: false },
      { id: 3, kind: 'audio', title: '日本語 (AAC Stereo)', language: undefined, ffIndex: 2, selected: true },
      { id: 4, kind: 'subtitle', title: 'English (PGS)', language: undefined, ffIndex: 3, selected: true },
      {
        id: 5,
        kind: 'subtitle',
        title: '中文 (SRT External)',
        language: undefined,
        url: 'https://plex.example:32400/library/streams/5',
        selected: false,
      },
    ]);
  });

  it('turns intro and credits markers into seconds and names the next episode', () => {
    const { context } = fakeFetch([]);
    const next = episode({ ratingKey: 502, title: 'Half Loop', index: 2 });
    const session = buildSession(context, SERVER, playableOf(episode())!, { next, settings: SETTINGS, strings: {} });
    expect(session.markers).toEqual([
      { kind: 'intro', start: 60, end: 120 },
      { kind: 'credits', start: 2900, end: 3000 },
    ]);
    expect(session.next).toEqual({ title: 'Severance', subtitle: 'S1 · E2 · Half Loop' });
  });

  it('has nothing to play without a file', () => {
    expect(playableOf(episode({ Media: [] }))).toBeNull();
  });

  it('binds every OSD action to keys', () => {
    const conf = inputConf();
    expect(conf).toContain('GAMEPAD_ACTION_DOWN script-binding playdeck/confirm\n');
    expect(conf).toContain('GAMEPAD_ACTION_RIGHT script-binding playdeck/back\n');
    expect(conf).toContain('GAMEPAD_LEFT_SHOULDER script-binding playdeck/prev-chapter\n');
    expect(conf).toContain('ESC script-binding playdeck/back\n');
  });
});

describe('next episode', () => {
  const leaves = [
    episode({ ratingKey: 400, parentIndex: 0, index: 1, title: 'Special' }),
    episode({ ratingKey: 501 }),
    episode({ ratingKey: 502, index: 2 }),
    episode({ ratingKey: 601, parentIndex: 2, index: 1 }),
  ];

  it('follows the show across seasons and skips specials', () => {
    expect(nextEpisodeIn(leaves, leaves[1])?.ratingKey).toBe('502');
    expect(nextEpisodeIn(leaves, leaves[2])?.ratingKey).toBe('601');
    expect(nextEpisodeIn(leaves, leaves[3])).toBeNull();
  });

  it('reads the show’s episodes from allLeaves', async () => {
    const { context, calls } = fakeFetch([
      ['GET', /\/library\/metadata\/500\/allLeaves$/, () => ({ body: { MediaContainer: { Metadata: [EPISODE, { ...EPISODE, ratingKey: 502 }] } } })],
    ]);
    expect((await fetchNextEpisode(context, SERVER, episode()))?.ratingKey).toBe('502');
    expect(calls[0].headers['X-Plex-Token']).toBe('secret-token');
  });
});

describe('Plex playback state', () => {
  it('reports the timeline in milliseconds', async () => {
    const { context, calls } = fakeFetch([['GET', /\/:\/timeline\?/, () => ({})]]);
    await reportTimeline(context, SERVER, { ratingKey: '501', state: 'paused', time: 1234.4, duration: 3_000_000 });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('key')).toBe('/library/metadata/501');
    expect(url.searchParams.get('state')).toBe('paused');
    expect(url.searchParams.get('time')).toBe('1234');
    expect(url.searchParams.has('X-Plex-Token')).toBe(false);
  });

  it('saves the track choice, with subtitle 0 for off', async () => {
    const { context, calls } = fakeFetch([['PUT', /\/library\/parts\/70\?/, () => ({})]]);
    await selectStreams(context, SERVER, 70, { subtitle: 0 });
    await selectStreams(context, SERVER, 70, { audio: 3 });
    expect(new URL(calls[0].url).searchParams.get('subtitleStreamID')).toBe('0');
    expect(new URL(calls[0].url).searchParams.has('audioStreamID')).toBe(false);
    expect(new URL(calls[1].url).searchParams.get('audioStreamID')).toBe('3');
    expect(new URL(calls[1].url).searchParams.has('subtitleStreamID')).toBe(false);
  });
});

describe('timeline reporter', () => {
  function reporter() {
    let now = 0;
    const reports: { state: string; time: number; duration: number }[] = [];
    const timeline = new TimelineReporter('501', 3_000_000, async (report) => void reports.push(report), () => now);
    return { timeline, reports, advance: (ms: number) => (now += ms) };
  }

  it('reports state changes at once and playing progress every 10 s', () => {
    const { timeline, reports, advance } = reporter();
    timeline.progress(1, 3000, false);
    advance(1000);
    timeline.progress(2, 3000, false);
    advance(1000);
    timeline.progress(3, 3000, true);
    advance(9000);
    timeline.progress(3, 3000, true);
    advance(1000);
    timeline.progress(3, 3000, true);
    expect(reports.map((report) => [report.state, report.time])).toEqual([
      ['playing', 1000],
      ['paused', 3000],
      ['paused', 3000],
    ]);
  });

  it('counts an item as watched past 90% or at its end', () => {
    const early = reporter();
    expect(early.timeline.end(2000, 3000, false)).toBe(false);
    expect(early.reports.at(-1)).toMatchObject({ state: 'stopped', time: 2_000_000 });

    const late = reporter();
    expect(late.timeline.end(2750, 3000, false)).toBe(true);
    expect(late.reports.at(-1)).toMatchObject({ state: 'stopped', time: 3_000_000 });

    const ended = reporter();
    expect(ended.timeline.end(100, 3000, true)).toBe(true);
  });
});
