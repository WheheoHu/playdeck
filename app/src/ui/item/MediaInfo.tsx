import { Fragment, memo } from 'react';
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
            <span key={flag}>{t(flag)}</span>
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
                  {tracks.map((track, i) => (
                    <TrackCard key={track.id} track={track} entry={i === 0} />
                  ))}
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
