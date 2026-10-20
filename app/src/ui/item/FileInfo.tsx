import type { ReactNode } from 'react';
import { formatBitrate, formatBytes, formatDuration } from '../../core/format';
import { type MediaItem, type MediaStream, fetchItem } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { FocusButton, FocusScope, useFocusable } from '../focus/react';
import { useResource } from '../resource';
import { useServers } from '../servers';

/** A focusable section, so the D-pad can scroll through long file details. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const ref = useFocusable<HTMLElement>();
  return (
    <section ref={ref} className="info-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function StreamList({ streams, empty }: { streams: MediaStream[]; empty: string }) {
  if (streams.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul>
      {streams.map((stream) => (
        <li key={stream.id}>
          {stream.title}
          {stream.forced && ' · forced'}
          {stream.external && ' · external'}
          {stream.default && ' · default'}
        </li>
      ))}
    </ul>
  );
}

export function FileInfo({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const { plex, t } = useApp();
  const { byId } = useServers();
  const server = byId(item.serverId);
  // Hub and list items carry no stream details; the full item does.
  const full = useResource(server ? `item:${item.serverId}:${item.ratingKey}` : null, () =>
    fetchItem(plex, server!, item.ratingKey),
  );
  const versions = full.data?.media ?? [];

  return (
    <FocusScope className="overlay" onBack={onClose} hints={{ b: 'hint.close' }}>
      <div className="info-panel" data-scroll="y">
        <div className="scroll-content">
          <h2>{t('info.title')}</h2>
          {full.loading && <p className="muted">{t('app.loading')}</p>}
          {versions.map((version, index) => {
            const streams = version.parts.flatMap((part) => part.streams);
            const summary = [
              version.videoResolution?.toUpperCase(),
              version.videoCodec?.toUpperCase(),
              formatBitrate(version.bitrate),
              version.container?.toUpperCase(),
              formatBytes(version.parts.reduce((sum, part) => sum + (part.size ?? 0), 0)),
              formatDuration(version.duration),
            ].filter(Boolean);
            return (
              <div key={version.id}>
                <Section title={versions.length > 1 ? t('info.version', { n: index + 1 }) : t('info.file')}>
                  <p>{summary.join(' · ')}</p>
                  {version.parts.map((part) => (
                    <p key={part.id} className="muted info-file">
                      {part.file?.split('/').pop()}
                    </p>
                  ))}
                </Section>
                <Section title={t('info.video')}>
                  <StreamList streams={streams.filter((s) => s.kind === 'video')} empty={t('info.none')} />
                </Section>
                <Section title={t('info.audio')}>
                  <StreamList streams={streams.filter((s) => s.kind === 'audio')} empty={t('info.none')} />
                </Section>
                <Section title={t('info.subtitles')}>
                  <StreamList streams={streams.filter((s) => s.kind === 'subtitle')} empty={t('info.none')} />
                </Section>
              </div>
            );
          })}
          <FocusButton onSelect={onClose}>{t('info.close')}</FocusButton>
        </div>
      </div>
    </FocusScope>
  );
}
