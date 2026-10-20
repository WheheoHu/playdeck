import type { MediaItem } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { FocusButton, FocusScope } from '../focus/react';
import { isWatched, routeFor, useNav } from '../nav';

export function ContextMenu({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const { t } = useApp();
  const nav = useNav();
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const title = item.type === 'episode' ? `${item.grandparentTitle} · ${item.title}` : item.title;

  return (
    <FocusScope className="overlay" onBack={onClose}>
      <div className="menu-panel">
        <h2>{title}</h2>
        <FocusButton autoFocus onSelect={run(() => nav.push(routeFor(item)))}>
          {t(item.type === 'episode' || item.type === 'season' ? 'item.goToShow' : 'item.open')}
        </FocusButton>
        <FocusButton onSelect={run(() => nav.toggleWatched(item))}>
          {t(isWatched(item) ? 'item.markUnwatched' : 'item.markWatched')}
        </FocusButton>
        {(item.type === 'movie' || item.type === 'episode') && (
          <FocusButton onSelect={run(() => nav.showFileInfo(item))}>{t('item.fileInfo')}</FocusButton>
        )}
        <FocusButton onSelect={onClose}>{t('settings.close')}</FocusButton>
      </div>
    </FocusScope>
  );
}
