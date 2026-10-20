import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { episodeLabel } from '../../core/format';
import { mergeContinueWatching, mergeRecentlyAdded } from '../../core/home';
import { type MediaItem, fetchContinueWatching, fetchRecentlyAdded, libraryId } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { Backdrop } from '../components/Backdrop';
import { ItemHeading } from '../components/ItemHeading';
import { type Row, Rows } from '../components/Rows';
import { useNav } from '../nav';
import { useResource } from '../resource';
import { useServers } from '../servers';

const HERO_DEBOUNCE_MS = 200;

interface HeroHandle {
  show(item: MediaItem): void;
}

/** Re-renders on its own, after focus settles, so moving through rows never re-renders the rows. */
const Hero = memo(
  forwardRef<HeroHandle>(function Hero(_props, ref) {
    const [item, setItem] = useState<MediaItem | null>(null);
    const timer = useRef(0);
    useImperativeHandle(
      ref,
      () => ({
        show(next) {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setItem(next), HERO_DEBOUNCE_MS);
        },
      }),
      [],
    );
    return (
      <>
        <Backdrop item={item} className="hero-backdrop" />
        <div className="hero-content">
          {item && (
            <>
              <ItemHeading item={item} />
              {item.summary && <p className="hero-summary">{item.summary}</p>}
            </>
          )}
        </div>
      </>
    );
  }),
);

export function HomeScreen() {
  const { plex, settings, t } = useApp();
  const { online, entries } = useServers();
  const nav = useNav();
  const hero = useRef<HeroHandle>(null);
  const hidden = settings.homeHiddenLibraries;
  const key = online.map((server) => server.id).sort().join(',') + (hidden.length ? `:hide=${[...hidden].sort()}` : '');

  // Filtered before merging, so hidden libraries do not use up the merged rows' length.
  const gather = async (fetch: (index: number) => Promise<MediaItem[]>) => {
    const lists = await Promise.all(online.map((_, index) => fetch(index).catch(() => [] as MediaItem[])));
    return lists.map((list) => list.filter((item) => !hidden.includes(libraryId(item))));
  };
  const continueWatching = useResource(key ? `home:continue:${key}` : null, async () =>
    mergeContinueWatching(await gather((i) => fetchContinueWatching(plex, online[i]))),
  );
  const movies = useResource(key ? `home:movies:${key}` : null, async () =>
    mergeRecentlyAdded(await gather((i) => fetchRecentlyAdded(plex, online[i], 1))),
  );
  const shows = useResource(key ? `home:shows:${key}` : null, async () =>
    mergeRecentlyAdded(await gather((i) => fetchRecentlyAdded(plex, online[i], 2))),
  );

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    if (continueWatching.data?.length) {
      list.push({
        id: 'continue',
        title: t('home.continueWatching'),
        entries: continueWatching.data.map((item) => ({
          key: `${item.serverId}:${item.ratingKey}`,
          item,
          badge: episodeLabel(item),
        })),
      });
    }
    if (movies.data?.length) {
      list.push({
        id: 'movies',
        title: t('home.recentMovies'),
        entries: movies.data.map(({ item }) => ({ key: `${item.serverId}:${item.ratingKey}`, item })),
      });
    }
    if (shows.data?.length) {
      list.push({
        id: 'shows',
        title: t('home.recentShows'),
        entries: shows.data.map(({ item, newEpisodes }) => ({
          key: `${item.serverId}:${item.ratingKey}`,
          item,
          badge: newEpisodes && newEpisodes > 1 ? t('home.newEpisodes', { count: newEpisodes }) : episodeLabel(item),
        })),
      });
    }
    return list;
  }, [continueWatching.data, movies.data, shows.data, t]);

  const onFocusItem = useCallback((item: MediaItem) => hero.current?.show(item), []);
  const waiting = entries === null || continueWatching.loading || movies.loading || shows.loading;

  return (
    <div className="home">
      <Hero ref={hero} />
      {rows.length > 0 ? (
        <Rows idPrefix="home" rows={rows} autoFocus onSelect={nav.open} onContext={nav.menu} onFocusItem={onFocusItem} />
      ) : (
        <p className="home-empty muted">{waiting ? t('app.loading') : t('home.empty')}</p>
      )}
    </div>
  );
}
