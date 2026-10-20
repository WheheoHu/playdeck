import { formatDuration } from '../../core/format';
import type { MediaItem } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { FocusButton } from '../focus/react';
import { isWatched, useNav } from '../nav';

export function ItemActions({ item, autoFocus }: { item: MediaItem; autoFocus?: boolean }) {
  const { t } = useApp();
  const nav = useNav();
  const resume = item.viewOffset ? formatDuration(item.viewOffset) : undefined;
  const playable = item.type === 'movie' || item.type === 'episode';

  return (
    <div className="item-actions">
      <FocusButton className="primary" autoFocus={autoFocus} onSelect={() => nav.toast(t('item.playSoon'))}>
        {resume ? t('item.resume', { time: resume }) : t('item.play')}
      </FocusButton>
      <FocusButton onSelect={() => nav.toggleWatched(item)}>
        {t(isWatched(item) ? 'item.markUnwatched' : 'item.markWatched')}
      </FocusButton>
      {playable && <FocusButton onSelect={() => nav.showFileInfo(item)}>{t('item.fileInfo')}</FocusButton>}
    </div>
  );
}

export function Credits({ item }: { item: MediaItem }) {
  const { t } = useApp();
  const lines = [
    item.genres.slice(0, 4).join(' · '),
    item.directors.length ? t('item.director', { names: item.directors.slice(0, 2).join(', ') }) : '',
    item.cast.length ? t('item.cast', { names: item.cast.slice(0, 4).map((member) => member.name).join(', ') }) : '',
  ].filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div className="item-credits">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
