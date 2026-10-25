import { describe, expect, it } from 'vitest';
import type { WebDavLibraryConfig, WebDavRequest, WebDavResponse } from '../shared/bridge';
import { buildSession, playableOf } from '../src/core/playback';
import {
  fetchChildren,
  fetchContinueWatching,
  fetchItem,
  fetchRecentlyAdded,
  fetchSectionPage,
  fetchSections,
  imageUrl,
  searchServer,
  setWatched,
} from '../src/core/plex/library';
import { fetchNextEpisode, reportTimeline } from '../src/core/plex/playback';
import {
  basicAuthHeader,
  buildWebDavUrl,
  normalizeWebDavUrl,
  parsePropfindXml,
} from '../src/core/webdav/client';
import {
  classifyMixedFolder,
  findArtwork,
  matchSubtitles,
  parseFilenameMetadata,
  parseNfo,
} from '../src/core/webdav/metadata';
import {
  initWebDavWatchStore,
  scanWebDavLibrary,
} from '../src/core/webdav/scanner';
import { webdavServerOf } from '../src/ui/servers';
import { fakeFetch } from './support';

describe('WebDAV URL and PROPFIND parsing', () => {
  it('normalizes user-entered URLs and encodes path segments', () => {
    expect(normalizeWebDavUrl('192.168.1.20:5244/dav/Movies/')).toEqual({
      baseUrl: 'http://192.168.1.20:5244',
      rootPath: '/dav/Movies',
    });
    expect(buildWebDavUrl('http://192.168.1.20:5244', '/dav/Movies/阿凡达 [4K]/video.mkv')).toBe(
      'http://192.168.1.20:5244/dav/Movies/%E9%98%BF%E5%87%A1%E8%BE%BE%20%5B4K%5D/video.mkv',
    );
    expect(basicAuthHeader('alice', 's3cret')).toBe('Basic YWxpY2U6czNjcmV0');
  });

  it('parses 207 Multi-Status XML, skips the self entry and dotfiles, and sorts directories first', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/dav/Media/</D:href>
          <D:propstat>
            <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/Media/.DS_Store</D:href>
          <D:propstat>
            <D:prop><D:getcontentlength>4096</D:getcontentlength></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/Media/Dune.Part.Two.2024.2160p.DV.HEVC.mkv</D:href>
          <D:propstat>
            <D:prop>
              <D:resourcetype/>
              <D:getcontentlength>25000000000</D:getcontentlength>
              <D:getlastmodified>Wed, 21 Oct 2026 07:28:00 GMT</D:getlastmodified>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/Media/Severance%20(2022)/</D:href>
          <D:propstat>
            <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
      </D:multistatus>`;

    const entries = parsePropfindXml(xml, '/dav/Media');
    expect(entries).toEqual([
      {
        path: '/dav/Media/Severance (2022)',
        name: 'Severance (2022)',
        isDirectory: true,
        size: undefined,
        lastModified: undefined,
      },
      {
        path: '/dav/Media/Dune.Part.Two.2024.2160p.DV.HEVC.mkv',
        name: 'Dune.Part.Two.2024.2160p.DV.HEVC.mkv',
        isDirectory: false,
        size: 25_000_000_000,
        lastModified: 1792567680,
      },
    ]);
  });
});

describe('NFO, filename, artwork and Mixed folder classification', () => {
  it('parses Kodi/Jellyfin movie and episode NFO files', () => {
    const nfo = parseNfo(`
      <movie>
        <title>Dune: Part Two</title>
        <year>2024</year>
        <plot>Paul Atreides unites with Chani and the Fremen.</plot>
        <tagline>Long live the fighters.</tagline>
        <mpaa>PG-13</mpaa>
        <ratings><rating name="imdb"><value>8.6</value></rating></ratings>
        <runtime>166</runtime>
        <genre>Science Fiction</genre>
        <genre>Adventure</genre>
        <director>Denis Villeneuve</director>
        <actor><name>Timothée Chalamet</name><role>Paul Atreides</role></actor>
      </movie>
    `);
    expect(nfo).toMatchObject({
      kind: 'movie',
      title: 'Dune: Part Two',
      year: 2024,
      summary: 'Paul Atreides unites with Chani and the Fremen.',
      tagline: 'Long live the fighters.',
      contentRating: 'PG-13',
      audienceRating: 8.6,
      duration: 166 * 60_000,
      genres: ['Science Fiction', 'Adventure'],
      directors: ['Denis Villeneuve'],
      cast: [{ name: 'Timothée Chalamet', role: 'Paul Atreides' }],
    });
  });

  it('extracts title, year, SxxExx and HDR/DoVi stream metadata from filenames', () => {
    const movie = parseFilenameMetadata('Blade.Runner.2049.2017.2160p.UHD.BluRay.DoVi.P8.HEVC.TrueHD.7.1.mkv');
    expect(movie).toMatchObject({
      title: 'Blade Runner 2049',
      year: 2017,
      videoResolution: '4k',
      videoCodec: 'hevc',
      audioCodec: 'truehd',
      dolbyVision: true,
      doviProfile: 8,
      colorTrc: 'smpte2084',
    });

    const ep = parseFilenameMetadata('Severance.S01E04.The.You.You.Are.1080p.WEB-DL.DDP5.1.H.265.mkv');
    expect(ep).toMatchObject({
      title: 'Severance',
      season: 1,
      episode: 4,
      episodeTitle: 'The You You Are',
      videoResolution: '1080',
      videoCodec: 'hevc',
      audioCodec: 'eac3',
    });
  });

  it('matches same-folder artwork and sidecar subtitles', () => {
    const entries = [
      { path: '/dav/Movie/Dune.2024.mkv', name: 'Dune.2024.mkv', isDirectory: false },
      { path: '/dav/Movie/poster.jpg', name: 'poster.jpg', isDirectory: false },
      { path: '/dav/Movie/fanart.jpg', name: 'fanart.jpg', isDirectory: false },
      { path: '/dav/Movie/Dune.2024.zh-CN.srt', name: 'Dune.2024.zh-CN.srt', isDirectory: false },
      { path: '/dav/Movie/Dune.2024.en.forced.ass', name: 'Dune.2024.en.forced.ass', isDirectory: false },
    ];
    expect(findArtwork(entries, 'Dune.2024.mkv')).toEqual({
      poster: '/dav/Movie/poster.jpg',
      art: '/dav/Movie/fanart.jpg',
      logo: undefined,
    });
    const subs = matchSubtitles('Dune.2024.mkv', entries, 10);
    expect(subs).toMatchObject([
      { id: 10, kind: 'subtitle', language: 'zh-Hans', title: '简体中文 (SRT)', key: '/dav/Movie/Dune.2024.zh-CN.srt', external: true },
      { id: 11, kind: 'subtitle', language: 'en', title: 'English (ASS)', key: '/dav/Movie/Dune.2024.en.forced.ass', forced: true },
    ]);
  });

  it('classifies Mixed folders into movies and shows', () => {
    const folder = { path: '/dav/Mixed/Item', name: 'Item', isDirectory: true };
    expect(
      classifyMixedFolder(folder, [{ path: '/dav/Mixed/Item/Season 1', name: 'Season 1', isDirectory: true }]),
    ).toBe('show');
    expect(
      classifyMixedFolder(folder, [
        { path: '/dav/Mixed/Item/Show.S01E01.mkv', name: 'Show.S01E01.mkv', isDirectory: false },
      ]),
    ).toBe('show');
    expect(
      classifyMixedFolder(folder, [
        { path: '/dav/Mixed/Item/Inception.2010.mkv', name: 'Inception.2010.mkv', isDirectory: false },
        { path: '/dav/Mixed/Item/poster.jpg', name: 'poster.jpg', isDirectory: false },
      ]),
    ).toBe('movie');
  });
});

function propfindXmlFor(dirPath: string, children: { name: string; isDir?: boolean; size?: number; mtime?: string }[]): string {
  const selfHref = `${dirPath.replace(/\/$/, '')}/`;
  const rows = [
    `<D:response><D:href>${encodeURI(selfHref)}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    ...children.map((c) => {
      const childPath = `${dirPath.replace(/\/$/, '')}/${c.name}${c.isDir ? '/' : ''}`;
      return `<D:response>
        <D:href>${encodeURI(childPath)}</D:href>
        <D:propstat>
          <D:prop>
            <D:resourcetype>${c.isDir ? '<D:collection/>' : ''}</D:resourcetype>
            ${c.size ? `<D:getcontentlength>${c.size}</D:getcontentlength>` : ''}
            ${c.mtime ? `<D:getlastmodified>${c.mtime}</D:getlastmodified>` : ''}
          </D:prop>
          <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
      </D:response>`;
    }),
  ];
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${rows.join('')}</D:multistatus>`;
}

describe('Mixed WebDAV library scanning, Home integration, and playback session', () => {
  const config: WebDavLibraryConfig = {
    id: 'webdav-test',
    name: 'NAS Media',
    baseUrl: 'http://192.168.1.50:5244',
    rootPath: '/dav/Media',
    username: 'user',
    password: 'pw',
    type: 'mixed',
  };

  const server = webdavServerOf(config);
  const { context } = fakeFetch([]);

  const mockTransport = async (req: WebDavRequest): Promise<WebDavResponse> => {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    if (req.method === 'PROPFIND') {
      if (pathname === '/dav/Media/') {
        return {
          status: 207,
          body: propfindXmlFor('/dav/Media', [
            { name: 'Oppenheimer (2023)', isDir: true },
            { name: 'Severance', isDir: true },
          ]),
        };
      }
      if (pathname === '/dav/Media/Oppenheimer (2023)/') {
        return {
          status: 207,
          body: propfindXmlFor('/dav/Media/Oppenheimer (2023)', [
            { name: 'Oppenheimer.2023.2160p.DV.HEVC.mkv', size: 18_000_000_000, mtime: 'Thu, 22 Oct 2026 10:00:00 GMT' },
            { name: 'Oppenheimer.2023.2160p.DV.HEVC.zh-CN.srt', size: 80_000 },
            { name: 'movie.nfo', size: 512 },
            { name: 'poster.jpg', size: 100_000 },
          ]),
        };
      }
      if (pathname === '/dav/Media/Severance/') {
        return {
          status: 207,
          body: propfindXmlFor('/dav/Media/Severance', [
            { name: 'tvshow.nfo', size: 512 },
            { name: 'poster.jpg', size: 100_000 },
            { name: 'Season 1', isDir: true },
          ]),
        };
      }
      if (pathname === '/dav/Media/Severance/Season 1/') {
        return {
          status: 207,
          body: propfindXmlFor('/dav/Media/Severance/Season 1', [
            { name: 'Severance.S01E01.Good.News.About.Hell.1080p.HEVC.mkv', size: 4_000_000_000, mtime: 'Thu, 22 Oct 2026 11:00:00 GMT' },
            { name: 'Severance.S01E02.Half.Loop.1080p.HEVC.mkv', size: 4_000_000_000, mtime: 'Thu, 22 Oct 2026 12:00:00 GMT' },
          ]),
        };
      }
    }
    if (req.method === 'GET') {
      if (pathname === '/dav/Media/Oppenheimer (2023)/movie.nfo') {
        return {
          status: 200,
          body: `<movie><title>Oppenheimer</title><year>2023</year><plot>The story of J. Robert Oppenheimer.</plot><runtime>180</runtime></movie>`,
        };
      }
      if (pathname === '/dav/Media/Severance/tvshow.nfo') {
        return {
          status: 200,
          body: `<tvshow><title>Severance</title><year>2022</year><plot>Mark leads a team of office workers.</plot></tvshow>`,
        };
      }
    }
    return { status: 404, body: 'not found' };
  };

  it('scans a Mixed library, serves Home/Library/Search queries, and builds authenticated mpv sessions', async () => {
    initWebDavWatchStore({});
    await scanWebDavLibrary(mockTransport, config);

    const sections = await fetchSections(context, server);
    expect(sections).toEqual([
      { serverId: 'webdav-test', key: 'main', type: 'mixed', title: 'NAS Media', isWebDav: true },
    ]);

    const page = await fetchSectionPage(context, server, sections[0], 0, 20, 'title');
    expect(page.totalSize).toBe(2);
    expect(page.items.map((i) => [i.type, i.title])).toEqual([
      ['movie', 'Oppenheimer'],
      ['show', 'Severance'],
    ]);

    const recentMovies = await fetchRecentlyAdded(context, server, 1);
    expect(recentMovies.map((m) => m.title)).toEqual(['Oppenheimer']);

    const recentEpisodes = await fetchRecentlyAdded(context, server, 2);
    expect(recentEpisodes.map((e) => [e.grandparentTitle, e.index, e.title])).toEqual([
      ['Severance', 2, 'Half Loop'],
      ['Severance', 1, 'Good News About Hell'],
    ]);

    // Check Show -> Season -> Episode hierarchy and next-episode resolution
    const show = page.items[1];
    const seasons = await fetchChildren(context, server, show.ratingKey);
    expect(seasons).toHaveLength(1);
    const episodes = await fetchChildren(context, server, seasons[0].ratingKey);
    expect(episodes).toHaveLength(2);
    const nextEp = await fetchNextEpisode(context, server, episodes[0]);
    expect(nextEp?.ratingKey).toBe(episodes[1].ratingKey);

    // Search
    const searchHits = await searchServer(context, server, 'oppen');
    expect(searchHits.map((h) => h.title)).toEqual(['Oppenheimer']);

    // Image proxy URL
    const posterUrl = imageUrl(server, page.items[0].thumb!, 154, 231, 1);
    expect(posterUrl).toContain('playdeck://app/__webdav__?lib=webdav-test');

    // Timeline reporting & Continue Watching / On Deck
    await reportTimeline(context, server, {
      ratingKey: episodes[0].ratingKey,
      state: 'stopped',
      time: 600_000,
      duration: 2_400_000,
    });
    const cwInProgress = await fetchContinueWatching(context, server);
    expect(cwInProgress[0].ratingKey).toBe(episodes[0].ratingKey);
    expect(cwInProgress[0].viewOffset).toBe(600_000);

    // Mark episode 1 watched -> episode 2 becomes On Deck in Continue Watching
    await setWatched(context, server, episodes[0].ratingKey, true);
    const cwOnDeck = await fetchContinueWatching(context, server);
    expect(cwOnDeck[0].ratingKey).toBe(episodes[1].ratingKey);

    // Build mpv PlaySession for the movie
    const movieFull = await fetchItem(context, server, page.items[0].ratingKey);
    const session = buildSession(context, server, playableOf(movieFull)!, {
      settings: {
        autoSkipMarkers: false,
        autoplayNext: true,
        networkMonitor: true,
        audioLanguage: 'ja',
        subtitleLanguage: 'zh-Hans',
      },
      strings: {},
    });
    expect(session.url).toBe('http://192.168.1.50:5244/dav/Media/Oppenheimer%20(2023)/Oppenheimer.2023.2160p.DV.HEVC.mkv');
    expect(session.httpHeaders).toEqual(['Authorization: Basic dXNlcjpwdw==']);
    expect(session.fileSize).toBe(18_000_000_000);
    expect(session.statsSections).toEqual(['video', 'timing', 'audio', 'network', 'scope']);
    expect(session.statsWaveform).toBe('rgb');
    expect(session.hdrSubtitleBrightness).toBe(203);
    expect(session.audioLanguage).toBe('ja');
    expect(session.subtitleLanguage).toBe('zh-Hans');
    expect(session.tracks).toEqual([
      {
        id: expect.any(Number),
        kind: 'subtitle',
        title: '简体中文 (SRT)',
        language: 'zh-Hans',
        url: 'http://192.168.1.50:5244/dav/Media/Oppenheimer%20(2023)/Oppenheimer.2023.2160p.DV.HEVC.zh-CN.srt',
        selected: true,
      },
    ]);
  });
});
