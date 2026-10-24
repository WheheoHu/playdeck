import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerEvent } from '../../shared/bridge';
import { en } from '../core/i18n/en';
import { type Playable, buildSession, inputConf, playTitles, playableOf } from '../core/playback';
import { type LibraryServer, type MediaItem, fetchItem, setWatched } from '../core/plex/library';
import { fetchNextEpisode, reportTimeline, selectStreams } from '../core/plex/playback';
import { TimelineReporter } from '../core/timeline';
import { useApp } from './AppContext';
import { FocusScope } from './focus/react';
import { useNav } from './nav';
import { invalidate } from './resource';
import { useServers } from './servers';

export interface PlayOptions {
  /** Ignore the resume offset. */
  fromStart?: boolean;
}

interface Playback {
  play(item: MediaItem, options?: PlayOptions): void;
}

const PlaybackContext = createContext<Playback | null>(null);

export function usePlayback(): Playback {
  const playback = useContext(PlaybackContext);
  if (!playback) throw new Error('usePlayback outside PlaybackProvider');
  return playback;
}

/** Everything cached about a server's items, after their watched state or resume offset changed. */
export function invalidateItems(serverId: string): void {
  for (const prefix of ['home:', `item:${serverId}:`, `children:${serverId}:`, 'search:']) invalidate(prefix);
}

const OSD_KEYS = Object.keys(en).filter((key) => key.startsWith('osd.')) as (keyof typeof en)[];
const STARTING_HINTS = { b: 'hint.cancel' };

const DRAW_FRAMES_MS = 1500;

/**
 * gamescope switches back to the panel's native rate only on a frame drawn a while after the request,
 * and an idle page draws none, so a faint animation keeps frames coming.
 */
function drawFrames(): void {
  document.body.animate([{ opacity: 0.999 }, { opacity: 1 }], { duration: DRAW_FRAMES_MS });
}

interface Current {
  server: LibraryServer;
  playable: Playable;
  /** The episode after this one, fetched when playback starts. */
  next: MediaItem | null;
  reporter?: TimelineReporter;
}

/**
 * Runs playback sessions in mpv (docs/DESIGN.md, section 3.3). While mpv plays, the UI window is
 * hidden; the overlay stays up so that nothing underneath takes input when it comes back.
 */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const { bridge, plex, settings, t, updateSettings } = useApp();
  const { byId } = useServers();
  const nav = useNav();
  const [starting, setStarting] = useState<string | null>(null);
  const active = useRef(false);
  /** The host was asked to start mpv; from then on only `ended` finishes the session. */
  const launched = useRef(false);
  const stopRequested = useRef(false);
  /** The video mpv has, or is about to have once it reports `playing`. */
  const current = useRef<Current | null>(null);
  const pending = useRef<Current | null>(null);
  const last = useRef({ position: 0, duration: 0 });
  const latest = useRef({ settings, t, nav, updateSettings });
  latest.current = { settings, t, nav, updateSettings };

  const sessionFor = useCallback(
    (entry: Current, options: PlayOptions = {}) => {
      const { settings, t } = latest.current;
      const strings = Object.fromEntries(OSD_KEYS.map((key) => [key, t(key)]));
      return buildSession(plex, entry.server, entry.playable, { ...options, next: entry.next, settings, strings });
    },
    [plex],
  );

  const prepare = useCallback(
    async (server: LibraryServer, item: MediaItem): Promise<Current> => {
      const [full, next] = await Promise.all([
        fetchItem(plex, server, item.ratingKey),
        fetchNextEpisode(plex, server, item).catch(() => null),
      ]);
      const playable = playableOf(full);
      if (!playable) throw new Error(latest.current.t('player.unplayable'));
      return { server, playable, next };
    },
    [plex],
  );

  /** The last report for a video; past the threshold (or moving on to the next) it is marked watched. */
  const finish = useCallback(
    (entry: Current | null, position: number, duration: number, reachedEnd: boolean) => {
      const reporter = entry?.reporter;
      if (!reporter) return;
      const { item } = entry.playable;
      const watched = reporter.end(position, duration, reachedEnd);
      reporter
        .settled()
        .then(() => (watched ? setWatched(plex, entry.server, item.ratingKey, true) : undefined))
        .catch((error: unknown) => console.warn('scrobble failed:', error))
        .finally(() => invalidateItems(item.serverId));
    },
    [plex],
  );

  const onNext = useCallback(async () => {
    const entry = current.current;
    if (!entry?.next) return bridge.player.stop();
    finish(entry, last.current.position, last.current.duration, true);
    current.current = null;
    try {
      const upcoming = await prepare(entry.server, entry.next);
      if (!active.current) return;
      pending.current = upcoming;
      await bridge.player.next(sessionFor(upcoming, { fromStart: true }));
    } catch (error) {
      console.error('next episode failed:', error);
      latest.current.nav.toast(latest.current.t('player.nextFailed'));
      bridge.player.stop();
    }
  }, [bridge, finish, prepare, sessionFor]);

  useEffect(
    () =>
      bridge.player.onEvent((event: PlayerEvent) => {
        switch (event.type) {
          case 'playing': {
            const entry = pending.current;
            if (!entry) return;
            pending.current = null;
            const { item, version } = entry.playable;
            entry.reporter = new TimelineReporter(item.ratingKey, version.duration ?? item.duration, (report) =>
              reportTimeline(plex, entry.server, report),
            );
            current.current = entry;
            return;
          }
          case 'progress':
            last.current = { position: event.position, duration: event.duration };
            current.current?.reporter?.progress(event.position, event.duration, event.paused);
            return;
          case 'tracks': {
            const entry = current.current;
            if (!entry) return;
            selectStreams(plex, entry.server, entry.playable.part.id, event).catch((error: unknown) =>
              console.warn('saving the track choice failed:', error),
            );
            return;
          }
          case 'next':
            void onNext();
            return;
          case 'networkMonitor':
            void latest.current.updateSettings({ networkMonitor: event.on });
            return;
          case 'subtitleScale':
            void latest.current.updateSettings({ subtitleScale: event.scale });
            return;
          case 'ended': {
            const wasActive = active.current;
            finish(current.current, event.position, event.duration, event.reachedEnd);
            current.current = pending.current = null;
            active.current = launched.current = false;
            setStarting(null);
            drawFrames();
            if (event.error && wasActive) latest.current.nav.toast(latest.current.t('player.failed', { message: event.error }));
            return;
          }
        }
      }),
    [bridge, plex, finish, onNext],
  );

  const play = useCallback(
    (item: MediaItem, options: PlayOptions = {}) => {
      if (active.current) return;
      const server = byId(item.serverId);
      const { nav, t } = latest.current;
      if (!server) return nav.toast(t('player.failed', { message: t('servers.offline') }));
      active.current = true;
      stopRequested.current = false;
      setStarting(playTitles(item).title);
      (async () => {
        const entry = await prepare(server, item);
        if (!active.current) return;
        pending.current = entry;
        last.current = { position: 0, duration: 0 };
        const { settings } = latest.current;
        launched.current = true;
        await bridge.player.start(sessionFor(entry, options), {
          hardwareDecoding: settings.hardwareDecoding,
          refreshSwitching: settings.refreshSwitching,
          subtitleScale: settings.subtitleScale,
          subtitleColor: settings.subtitleColor,
          subtitleBackground: settings.subtitleBackground,
          hdrSubtitleBrightness: settings.hdrSubtitleBrightness,
          inputConf: inputConf(),
        });
        // A cancel that reached the host before mpv existed did nothing there.
        if (stopRequested.current) bridge.player.stop();
      })().catch((error: unknown) => {
        if (!active.current) return;
        active.current = launched.current = false;
        pending.current = null;
        setStarting(null);
        nav.toast(t('player.failed', { message: error instanceof Error ? error.message : String(error) }));
      });
    },
    [bridge, byId, prepare, sessionFor],
  );

  /** Before mpv is asked for this just forgets the request; after, mpv quits and `ended` cleans up. */
  const cancel = useCallback(() => {
    if (launched.current) {
      stopRequested.current = true;
      bridge.player.stop();
      return;
    }
    active.current = false;
    setStarting(null);
  }, [bridge]);

  const value = useMemo(() => ({ play }), [play]);

  return (
    <PlaybackContext.Provider value={value}>
      {children}
      {starting !== null && (
        <FocusScope className="overlay player-starting" onBack={cancel} hints={STARTING_HINTS}>
          <div className="spinner" />
          <p>{t('player.starting', { title: starting })}</p>
        </FocusScope>
      )}
    </PlaybackContext.Provider>
  );
}
