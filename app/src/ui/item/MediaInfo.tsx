import { Fragment, memo, useCallback, useLayoutEffect, useRef } from 'react';
import { type TrackInfo, trackInfo, versionSummary } from '../../core/mediaInfo';
import type { MediaItem } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { useFocusable } from '../focus/react';

/** `entry` is where focus lands when it comes into the row. */
const TrackCard = memo(function TrackCard({ track, entry }: { track: TrackInfo; entry: boolean }) {
  const { t } = useApp();
  const ref = useFocusable<HTMLDivElement>();
  return (
    <div ref={ref} className={`track-card ${track.kind}`} data-hint-a="" data-focus-entry={entry ? '' : undefined}>
      <div className="track-kind">
        <span>{t(`info.${track.kind}`)}</span>
        {track.count > 1 && (
          <span className="track-count">
            {track.index} / {track.count}
          </span>
        )}
      </div>
      <div className="track-title">{track.title}</div>
      {track.flags.length > 0 && (
        <div className="track-flags">
          {track.flags.map((flag) => (
            <span key={flag} className="track-flag">
              {t(flag)}
            </span>
          ))}
        </div>
      )}
      <dl className="track-facts">
        {track.facts.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{t(label)}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
});

/**
 * Every subtitle track in one card, as a list. A list longer than the card turns a page per right
 * stick (or wheel) step, so the D-pad still moves between cards.
 */
const SubtitleCard = memo(function SubtitleCard({ tracks, entry }: { tracks: TrackInfo[]; entry: boolean }) {
  const { t } = useApp();
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const offset = useRef(0);

  function scrollTo(next: number) {
    const rows = [...list.current!.children] as HTMLElement[];
    const height = viewport.current!.clientHeight;
    const max = Math.max(0, list.current!.offsetHeight - height);
    offset.current = Math.max(0, Math.min(next, max));
    list.current!.style.transform = `translate3d(0, ${-offset.current}px, 0)`;
    viewport.current!.classList.toggle('more-below', offset.current < max);
    const shown = rows.filter((row) => row.offsetTop >= offset.current && row.offsetTop + row.offsetHeight <= offset.current + height + 1);
    if (max > 0 && shown.length > 0) {
      range.current!.textContent = `${rows.indexOf(shown[0]) + 1}–${rows.indexOf(shown.at(-1)!) + 1} / ${rows.length}`;
    }
  }

  function page(down: boolean) {
    const rows = [...list.current!.children] as HTMLElement[];
    const height = viewport.current!.clientHeight;
    // Down: the first row cut off at the bottom comes to the top. Up: back by a page, on a row edge.
    const target = down
      ? rows.find((row) => row.offsetTop + row.offsetHeight > offset.current + height + 1)?.offsetTop
      : rows.find((row) => row.offsetTop >= offset.current - height)?.offsetTop;
    scrollTo(target ?? offset.current);
  }

  const focusRef = useFocusable<HTMLDivElement>(undefined, (action) => {
    if (action !== 'scroll-up' && action !== 'scroll-down') return false;
    page(action === 'scroll-down');
    return true;
  });
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      card.current = element;
      focusRef(element);
    },
    [focusRef],
  );

  useLayoutEffect(() => {
    const scrollable = list.current!.offsetHeight > viewport.current!.clientHeight;
    card.current!.dataset.hintRs = scrollable ? 'hint.scroll' : '';
    scrollTo(0);
  }, [tracks]);

  return (
    <div ref={ref} className="track-card subtitle" data-hint-a="" data-focus-entry={entry ? '' : undefined}>
      <div className="track-kind">
        <span>{t('info.subtitles')}</span>
        <span className="track-count" ref={range}>
          {tracks.length}
        </span>
      </div>
      <div className="subtitle-viewport" ref={viewport}>
        <div className="subtitle-list" ref={list}>
          {tracks.map((track) => (
            <div key={track.id} className="subtitle-row">
              <div className="subtitle-title">
                <span>{track.title}</span>
                {track.flags.map((flag) => (
                  <span key={flag} className="track-flag">
                    {t(flag)}
                  </span>
                ))}
              </div>
              <div className="subtitle-meta muted">{track.facts.map(([, value]) => value).join(' · ')}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

interface MediaInfoProps {
  /** The full item; list and hub items carry no track details. */
  item: MediaItem | undefined;
  failed?: boolean;
  /** Names what the information is for, e.g. the focused episode. */
  label?: string;
}

/** Each version's file summary and its tracks, as a row of cards under a detail page. */
export const MediaInfo = memo(function MediaInfo({ item, failed, label }: MediaInfoProps) {
  const { t } = useApp();
  const versions = item?.media ?? [];
  const message = failed ? t('info.loadFailed') : !item ? t('app.loading') : versions.length === 0 ? t('info.unavailable') : null;

  return (
    <section className="media-info" data-scroll-block="">
      <header className="media-info-head">
        <h2>{t('info.title')}</h2>
        {label && <span className="muted">{label}</span>}
      </header>
      {message && <p className="media-info-message muted">{message}</p>}
      {versions.map((version, index) => {
        const tracks = trackInfo(version, t);
        const cards = tracks.filter((track) => track.kind !== 'subtitle');
        const subtitles = tracks.filter((track) => track.kind === 'subtitle');
        const files = version.parts.flatMap((part) => (part.file ? [part.file.split('/').pop()] : []));
        return (
          <div key={version.id} className="media-version">
            <p className="media-file">
              {versions.length > 1 && <strong>{t('info.version', { n: index + 1, count: versions.length })}</strong>}
              <span>{versionSummary(version).join(' · ')}</span>
              {files.length > 0 && <span className="muted media-file-name">{files.join(', ')}</span>}
            </p>
            {tracks.length > 0 ? (
              <div className="track-row" data-scroll="x" data-focus-group="">
                <div className="scroll-content track-row-content">
                  {cards.map((track, i) => (
                    <TrackCard key={track.id} track={track} entry={i === 0} />
                  ))}
                  {subtitles.length > 0 && <SubtitleCard tracks={subtitles} entry={cards.length === 0} />}
                </div>
              </div>
            ) : (
              <p className="media-info-message muted">{t('info.unavailable')}</p>
            )}
          </div>
        );
      })}
    </section>
  );
});
