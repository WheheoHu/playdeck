import type { MediaItem } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { FocusButton, FocusScope } from '../focus/react';
import { type Route, isWatched, routeFor, useNav } from '../nav';

const MENU_HINTS = { b: 'hint.close' };

/** The X-button menu. `here` is the page underneath, so the menu never offers to open it again. */
export function ContextMenu({ item, here, onClose }: { item: MediaItem; here?: Route; onClose: () => void }) {
  const { t } = useApp();
  const nav = useNav();
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const title = item.type === 'episode' ? `${item.grandparentTitle} · ${item.title}` : item.title;
  const target = routeFor(item);
  const isHere =
    here?.kind === 'item' && target.kind === 'item' && here.serverId === target.serverId && here.ratingKey === target.ratingKey;

  return (
    <FocusScope className="overlay" onBack={onClose} hints={MENU_HINTS}>
      <div className="menu-panel">
        <h2>{title}</h2>
        {!isHere && (
          <FocusButton autoFocus onSelect={run(() => nav.push(target))}>
            {t(item.type === 'episode' || item.type === 'season' ? 'item.goToShow' : 'item.open')}
          </FocusButton>
        )}
        <FocusButton autoFocus={isHere} onSelect={run(() => nav.toggleWatched(item))}>
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
