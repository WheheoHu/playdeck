import { describe, expect, it } from 'vitest';
import { mergeContinueWatching, mergeRecentlyAdded, posterOf, progressOf } from '../src/core/home';
import { type MediaItem, type RawMetadata, fetchSectionPage, imageUrl, libraryId, parseItem } from '../src/core/plex/library';
import { fakeFetch } from './support';

const SERVER = { id: 'srv', name: 'Home', baseUrl: 'https://plex.example:32400', token: 'tok' };

const MOVIE: RawMetadata = {
  ratingKey: 100,
  type: 'movie',
  title: 'Sample Movie',
  year: 2026,
  thumb: '/library/metadata/100/thumb/1',
  art: '/library/metadata/100/art/1',
  Image: [
    { type: 'coverPoster', url: '/poster' },
    { type: 'clearLogo', url: '/library/metadata/100/clearLogo/1' },
  ],
  UltraBlurColors: { topLeft: '0a1b2c', topRight: '112233', bottomRight: '445566', bottomLeft: '778899' },
  Genre: [{ tag: 'Science Fiction' }],
  Role: [{ tag: 'Jane Doe', role: 'Lead' }],
  Media: [
    {
      id: 200,
      videoResolution: '4k',
      videoCodec: 'hevc',
      Part: [
        {
          id: 1,
          key: '/library/parts/200/1/file.mkv',
          Stream: [
            { id: 1, streamType: 1, codec: 'hevc', extendedDisplayTitle: '4K DoVi/HDR10+ (HEVC Main 10)', DOVIProfile: 8 },
            { id: 2, streamType: 2, codec: 'eac3', displayTitle: 'English (EAC3 5.1)', default: true },
            { id: 3, streamType: 3, codec: 'srt', displayTitle: '中文', key: '/library/streams/3' },
            { id: 4, streamType: 4, codec: 'unknown' },
          ],
        },
      ],
    },
  ],
};

function item(overrides: Partial<MediaItem>): MediaItem {
  return { ...parseItem('srv', { ratingKey: 1, type: 'movie', title: 'x' }), ...overrides };
}

describe('parseItem', () => {
  it('extracts artwork, tags and streams', () => {
    const parsed = parseItem('srv', MOVIE);
    expect(parsed).toMatchObject({
      serverId: 'srv',
      ratingKey: '100',
      type: 'movie',
      logo: '/library/metadata/100/clearLogo/1',
      ultraBlur: { topLeft: '0a1b2c', bottomLeft: '778899' },
      genres: ['Science Fiction'],
      cast: [{ name: 'Jane Doe', role: 'Lead' }],
    });
    const streams = parsed.media[0].parts[0].streams;
    expect(streams.map((s) => [s.kind, s.title])).toEqual([
      ['video', '4K DoVi/HDR10+ (HEVC Main 10)'],
      ['audio', 'English (EAC3 5.1)'],
      ['subtitle', '中文'],
    ]);
    expect(streams[0].doviProfile).toBe(8);
    expect(streams[2].external).toBe(true);
  });

  it('maps unknown types to other', () => {
    expect(parseItem('srv', { ratingKey: 1, type: 'artist' }).type).toBe('other');
  });
});

describe('home merging', () => {
  it('lists a show once, preferring its in-progress episode, newest first, across servers', () => {
    const next = item({ ratingKey: 'e2', type: 'episode', grandparentRatingKey: 'show', lastViewedAt: 300 });
    const inProgress = item({ ratingKey: 'e1', type: 'episode', grandparentRatingKey: 'show', viewOffset: 5, lastViewedAt: 300 });
    const movie = item({ ratingKey: 'm', lastViewedAt: 400 });
    const otherServer = item({ serverId: 'srv2', ratingKey: 'm', lastViewedAt: 100 });
    const merged = mergeContinueWatching([[next, inProgress, movie, movie], [otherServer]]);
    expect(merged.map((m) => `${m.serverId}:${m.ratingKey}`)).toEqual(['srv:m', 'srv:e1', 'srv2:m']);
  });

  it('folds new episodes into their show and orders by the newest addition', () => {
    const e1 = item({ ratingKey: 'e1', type: 'episode', grandparentRatingKey: 'blue', addedAt: 10 });
    const e2 = item({ ratingKey: 'e2', type: 'episode', grandparentRatingKey: 'blue', addedAt: 30 });
    const season = item({ ratingKey: 's', type: 'season', parentRatingKey: 'silo', leafCount: 10, addedAt: 20 });
    const merged = mergeRecentlyAdded([[e1, season, e2]]);
    expect(merged.map((e) => [e.item.ratingKey, e.newEpisodes])).toEqual([
      ['e2', 2],
      ['s', 10],
    ]);
  });

  it('uses the show poster for episodes and computes progress', () => {
    const episode = item({ type: 'episode', thumb: '/ep', grandparentThumb: '/show', viewOffset: 25, duration: 100 });
    expect(posterOf(episode)).toBe('/show');
    expect(progressOf(episode)).toBe(0.25);
    expect(progressOf(item({}))).toBeNull();
  });
});

describe('library requests', () => {
  it('pages through a section sorted by title', async () => {
    const fake = fakeFetch([
      ['GET', /\/library\/sections\/3\/all\?/, () => ({ body: { MediaContainer: { size: 1, totalSize: 120, Metadata: [MOVIE] } } })],
    ]);
    const page = await fetchSectionPage(fake.context, SERVER, { serverId: 'srv', key: '3', type: 'movie', title: 'Movies' }, 100, 50);
    expect(page.totalSize).toBe(120);
    expect(page.items[0].title).toBe('Sample Movie');
    const url = new URL(fake.calls[0].url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      type: '1',
      sort: 'titleSort',
      'X-Plex-Container-Start': '100',
      'X-Plex-Container-Size': '50',
    });
    expect(fake.calls[0].headers['X-Plex-Token']).toBe('tok');
  });

  it('orders shows by their newest episode for "date added"', async () => {
    const fake = fakeFetch([['GET', /\/all\?/, () => ({ body: { MediaContainer: { size: 0, totalSize: 0 } } })]]);
    const shows = { serverId: 'srv', key: '2', type: 'show' as const, title: 'TV Shows' };
    await fetchSectionPage(fake.context, SERVER, shows, 0, 10, 'added');
    await fetchSectionPage(fake.context, SERVER, { ...shows, type: 'movie' }, 0, 10, 'added');
    await fetchSectionPage(fake.context, SERVER, shows, 0, 10, 'rating');
    const sorts = fake.calls.map((call) => new URL(call.url).searchParams.get('sort'));
    expect(sorts).toEqual(['episode.addedAt:desc', 'addedAt:desc', 'audienceRating:desc']);
  });

  it('identifies the library an item came from', () => {
    const episode = parseItem('srv', { ...MOVIE, librarySectionID: 6 });
    expect(libraryId(episode)).toBe('srv/6');
    expect(libraryId({ serverId: 'srv', key: '6', type: 'show', title: 'Anime' })).toBe('srv/6');
  });

  it('builds transcoder URLs in physical pixels', () => {
    const url = new URL(imageUrl(SERVER, '/library/metadata/1/thumb/2', 140, 210, 2));
    expect(url.pathname).toBe('/photo/:/transcode');
    expect(url.searchParams.get('width')).toBe('280');
    expect(url.searchParams.get('height')).toBe('420');
    expect(url.searchParams.get('url')).toBe('/library/metadata/1/thumb/2');
  });
});
