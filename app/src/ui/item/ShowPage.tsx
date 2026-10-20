import {
  type MutableRefObject,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { episodeLabel, formatDuration } from '../../core/format';
import { progressOf } from '../../core/home';
import { type MediaItem, fetchChildren, fetchItem, imageUrl } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { Glyph } from '../components/Hints';
import { ItemHeading } from '../components/ItemHeading';
import { Poster } from '../components/Poster';
import type { FocusTarget } from '../focus/manager';
import { FocusButton, useFocusManager, useRegion } from '../focus/react';
import type { Action } from '../input';
import { PAD_X, focusedCardRect, imageScale } from '../layout';
import { type Route, isWatched, useNav } from '../nav';
import { usePlayback } from '../playback';
import { useResource } from '../resource';
import { useServers } from '../servers';
import { MediaInfo } from './MediaInfo';

const STILL_W = 288;
const STILL_H = 162;
const STILL_STRIDE = STILL_W + 20;
/** Episodes left of the focused one before the strip scrolls. */
const STRIP_LEAD = 1;
const STRIP_VISIBLE = 4;
/** Cards mounted beyond the visible ones on each side; long seasons are never mounted whole. */
const STRIP_OVERSCAN = 3;
/** Mirrors .strip-viewport padding: room for a focused card's scale-up. */
const BLEED = 12;
const INFO_DEBOUNCE_MS = 120;
/** Longer than the info's: each settle fetches the episode. */
const MEDIA_DEBOUNCE_MS = 300;

type ItemRoute = Extract<Route, { kind: 'item' }>;

const EMPTY: MediaItem[] = [];

/** The first episode not yet finished, so a season opens where the viewer left off. */
function nextUp(episodes: MediaItem[]): number {
  const index = episodes.findIndex((episode) => !isWatched(episode));
  return index < 0 ? 0 : index;
}

interface InfoHandle {
  show(episode: MediaItem): void;
}

/** The focused episode's details; re-renders on its own, after focus settles, like the home hero. */
const EpisodeInfo = memo(
  forwardRef<InfoHandle>(function EpisodeInfo(_props, ref) {
    const { t } = useApp();
    const [episode, setEpisode] = useState<MediaItem | null>(null);
    const timer = useRef(0);
    const shown = useRef(false);
    useImperativeHandle(
      ref,
      () => ({
        show(next) {
          window.clearTimeout(timer.current);
          if (!shown.current) {
            shown.current = true;
            setEpisode(next);
          } else {
            timer.current = window.setTimeout(() => setEpisode(next), INFO_DEBOUNCE_MS);
          }
        },
      }),
      [],
    );

    if (!episode) return <div className="episode-info" />;
    const left = episode.viewOffset && episode.duration ? formatDuration(episode.duration - episode.viewOffset) : undefined;
    const facts = [
      formatDuration(episode.duration),
      episode.originallyAvailableAt,
      episode.audienceRating ? `★ ${episode.audienceRating.toFixed(1)}` : undefined,
      left ? t('item.left', { time: left }) : isWatched(episode) ? '✓' : undefined,
    ].filter(Boolean);
    return (
      <div className="episode-info">
        <div className="episode-info-title">
          <span className="muted">{episodeLabel(episode)}</span> {episode.title}
        </div>
        <div className="item-facts">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
        {episode.summary && <p className="episode-info-summary">{episode.summary}</p>}
      </div>
    );
  }),
);

/**
 * The focused episode's media information below the fold. Episode lists carry no track details, so
 * the full episode loads once focus has rested on it; the last one stays until the next arrives.
 */
const EpisodeMedia = memo(
  forwardRef<InfoHandle>(function EpisodeMedia(_props, ref) {
    const { plex } = useApp();
    const { byId } = useServers();
    const [episode, setEpisode] = useState<MediaItem | null>(null);
    const timer = useRef(0);
    useImperativeHandle(
      ref,
      () => ({
        show(next) {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setEpisode(next), MEDIA_DEBOUNCE_MS);
        },
      }),
      [],
    );
    useEffect(() => () => window.clearTimeout(timer.current), []);

    const server = episode ? byId(episode.serverId) : undefined;
    const full = useResource(server && episode ? `item:${episode.serverId}:${episode.ratingKey}` : null, () =>
      fetchItem(plex, server!, episode!.ratingKey),
    );
    const last = useRef<MediaItem | undefined>(undefined);
    if (full.data) last.current = full.data;
    const shown = last.current;
    const label = shown && [episodeLabel(shown), shown.title].filter(Boolean).join(' ');
    return <MediaInfo item={shown} failed={!shown && Boolean(full.error)} label={label} />;
  }),
);

const EpisodeCard = memo(function EpisodeCard({ episode, index, src }: { episode: MediaItem; index: number; src?: string }) {
  return (
    <div className="strip-cell" style={{ transform: `translate3d(${index * STILL_STRIDE}px, 0, 0)` }}>
      <Poster
        id={`episode-${episode.ratingKey}`}
        variant="landscape"
        src={src}
        title={episode.title}
        progress={progressOf(episode)}
        watched={isWatched(episode)}
      />
      <div className="strip-caption">
        <span className="muted">{episode.index ?? ''}</span> {episode.title}
      </div>
    </div>
  );
});

interface StripProps {
  /** Identifies the season; a new season starts at `initial`, a refreshed one keeps its position. */
  seasonKey: string;
  episodes: MediaItem[];
  initial: number;
  onFocusEpisode: (episode: MediaItem) => void;
}

/** One season's episodes as a horizontal focus region. */
function EpisodeStrip({ seasonKey, episodes, initial, onFocusEpisode }: StripProps) {
  const { byId } = useServers();
  const nav = useNav();
  const playback = usePlayback();
  const manager = useFocusManager();
  const viewport = useRef<HTMLDivElement | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const index = useRef(initial);
  const season = useRef<string | null>(null);
  /** Whether focus is in the strip; stays set while a season change replaces the focused card. */
  const owned = useRef(false);
  /** Focus waits for the cards of a window that moved with a new season. */
  const pending = useRef(false);
  const [windowStart, setWindowStart] = useState(() => Math.max(0, initial - STRIP_LEAD - STRIP_OVERSCAN));

  useEffect(() => {
    const sync = () => {
      const focused = manager.focused;
      owned.current = Boolean(focused && viewport.current?.contains(focused));
    };
    sync();
    return manager.subscribe(sync);
  }, [manager]);

  /** `fromInput` is false inside React effects, where cards cannot be flushed synchronously. */
  function settle(fromInput = true): FocusTarget | null {
    if (episodes.length === 0 || !viewport.current) return null;
    const i = Math.min(index.current, episodes.length - 1);
    index.current = i;
    const scroll = Math.max(0, Math.min(i - STRIP_LEAD, episodes.length - STRIP_VISIBLE));
    track.current!.style.transform = `translate3d(${-scroll * STILL_STRIDE}px, 0, 0)`;
    const start = Math.max(0, scroll - STRIP_OVERSCAN);
    if (start !== windowStart) {
      if (fromInput) flushSync(() => setWindowStart(start));
      else setWindowStart(start);
    }
    onFocusEpisode(episodes[i]);
    const element = document.getElementById(`episode-${episodes[i].ratingKey}`);
    if (!element) return null;
    const box = viewport.current.getBoundingClientRect();
    return {
      element,
      rect: focusedCardRect(box.left + PAD_X + (i - scroll) * STILL_STRIDE, box.top + BLEED, STILL_W, STILL_H),
    };
  }

  const regionRef = useRegion<HTMLDivElement>({
    enter: () => settle(),
    move: (_focused, direction) => {
      if (direction === 'up' || direction === 'down') return null;
      const next = index.current + (direction === 'left' ? -1 : 1);
      if (next < 0 || next >= episodes.length) return null;
      index.current = next;
      return settle();
    },
    action: (_focused, action) => {
      const episode = episodes[index.current];
      if (!episode) return false;
      if (action === 'select') playback.play(episode);
      else if (action === 'context') nav.menu(episode);
      else return false;
      return true;
    },
  });

  useLayoutEffect(() => {
    if (season.current !== seasonKey) {
      season.current = seasonKey;
      index.current = initial;
    }
    const target = settle(false);
    if (!owned.current) return;
    if (target) manager.focus(target);
    else pending.current = true;
  }, [seasonKey, episodes, initial]);

  useLayoutEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    manager.focus(settle(false));
  }, [windowStart]);

  const viewportRef = useCallback(
    (element: HTMLDivElement | null) => {
      viewport.current = element;
      regionRef(element);
    },
    [regionRef],
  );

  const end = Math.min(episodes.length, windowStart + STRIP_VISIBLE + 2 * STRIP_OVERSCAN);
  const cards = [];
  for (let i = windowStart; i < end; i++) {
    const episode = episodes[i];
    const server = byId(episode.serverId);
    const src = server && episode.thumb ? imageUrl(server, episode.thumb, STILL_W, STILL_H, imageScale()) : undefined;
    cards.push(<EpisodeCard key={episode.ratingKey} episode={episode} index={i} src={src} />);
  }

  return (
    <div className="strip-viewport" data-autofocus="" data-hint-a="hint.play" data-hint-x="hint.options" ref={viewportRef}>
      <div className="strip-track" ref={track}>
        {cards}
      </div>
    </div>
  );
}

interface ShowPageProps {
  show: MediaItem;
  route: ItemRoute;
  /** Set to the page's handler for actions no focused element takes (LB/RB switch seasons). */
  actions: MutableRefObject<((action: Action) => boolean) | null>;
}

export function ShowPage({ show, route, actions }: ShowPageProps) {
  const { plex, t } = useApp();
  const { byId } = useServers();
  const nav = useNav();
  const playback = usePlayback();
  const manager = useFocusManager();
  const server = byId(show.serverId);
  const info = useRef<InfoHandle>(null);
  const media = useRef<InfoHandle>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const seasons = useResource(server ? `children:${show.serverId}:${show.ratingKey}` : null, () =>
    fetchChildren(plex, server!, show.ratingKey),
  );
  const [chosen, setChosen] = useState(route.season);
  const active =
    chosen ??
    seasons.data?.find((season) => (season.viewedLeafCount ?? 0) < (season.leafCount ?? 0))?.ratingKey ??
    seasons.data?.[0]?.ratingKey;
  const episodes = useResource(server && active ? `children:${show.serverId}:${active}` : null, () =>
    fetchChildren(plex, server!, active!),
  );
  // The previous season stays on screen while the next one loads, so the strip (and focus in it)
  // survives a season switch.
  const shown = useRef<{ season: string; list: MediaItem[] } | null>(null);
  if (active && episodes.data && (shown.current?.season !== active || shown.current.list !== episodes.data)) {
    shown.current = { season: active, list: episodes.data };
  }
  const shownSeason = shown.current?.season;
  const list = shown.current?.list ?? EMPTY;
  const initial = useMemo(() => {
    const jump =
      route.episode && shownSeason === route.season ? list.findIndex((e) => e.ratingKey === route.episode) : -1;
    return jump >= 0 ? jump : nextUp(list);
  }, [list, shownSeason, route.episode, route.season]);
  const onFocusEpisode = useCallback((episode: MediaItem) => {
    info.current?.show(episode);
    media.current?.show(episode);
  }, []);

  actions.current = (action) => {
    if (action !== 'previous-tab' && action !== 'next-tab') return false;
    const all = seasons.data ?? [];
    const next = all[all.findIndex((season) => season.ratingKey === active) + (action === 'next-tab' ? 1 : -1)];
    if (next) setChosen(next.ratingKey);
    return all.length > 1;
  };

  // A focused season tab follows the selection; otherwise the tabs just scroll to it.
  useLayoutEffect(() => {
    const selected = tabs.current?.querySelector<HTMLElement>('[data-focus-entry]');
    if (!selected) return;
    const focused = manager.focused;
    if (focused && focused !== selected && tabs.current!.contains(focused)) manager.focus({ element: selected });
    else manager.reveal(selected);
  }, [active, seasons.data, manager]);

  const upNext = list[initial];
  const label = upNext && episodeLabel(upNext);
  const resume = upNext?.viewOffset ? formatDuration(upNext.viewOffset) : undefined;
  const play = !label ? t('item.play') : resume ? `${t('item.resume', { time: resume })} · ${label}` : t('item.playEpisode', { label });

  return (
    <>
      <div className="show-hero" data-scroll-block="">
        <div className="show-top">
          <ItemHeading item={show} />
          <EpisodeInfo ref={info} />
          <div className="item-actions">
            <FocusButton className="primary" onSelect={() => upNext && playback.play(upNext)}>
              {play}
            </FocusButton>
            <FocusButton onSelect={() => nav.toggleWatched(show)}>
              {t(isWatched(show) ? 'item.markUnwatched' : 'item.markWatched')}
            </FocusButton>
          </div>
        </div>
        {seasons.data && seasons.data.length > 1 && (
          <div className="season-bar">
            <Glyph button="lb" />
            <div className="season-tabs" data-scroll="x" data-focus-group="" ref={tabs}>
              <div className="scroll-content row-content">
                {seasons.data.map((season) => (
                  <FocusButton
                    key={season.ratingKey}
                    className={season.ratingKey === active ? 'season-tab selected' : 'season-tab'}
                    data-focus-entry={season.ratingKey === active ? '' : undefined}
                    onSelect={() => setChosen(season.ratingKey)}
                  >
                    {season.title}
                  </FocusButton>
                ))}
              </div>
            </div>
            <Glyph button="rb" />
          </div>
        )}
        {shownSeason && list.length > 0 ? (
          <EpisodeStrip seasonKey={shownSeason} episodes={list} initial={initial} onFocusEpisode={onFocusEpisode} />
        ) : (
          <p className="strip-message muted">{episodes.loading || seasons.loading ? t('app.loading') : ''}</p>
        )}
      </div>
      <EpisodeMedia ref={media} />
    </>
  );
}
