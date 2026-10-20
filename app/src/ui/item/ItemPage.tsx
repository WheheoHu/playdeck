import { useCallback, useRef } from 'react';
import { qualityBadges } from '../../core/format';
import { fetchItem } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { Backdrop } from '../components/Backdrop';
import { ItemHeading } from '../components/ItemHeading';
import { FocusScope } from '../focus/react';
import type { Action } from '../input';
import { type Route, useNav } from '../nav';
import { useResource } from '../resource';
import { useServers } from '../servers';
import { Credits, ItemActions } from './ItemActions';
import { MediaInfo } from './MediaInfo';
import { ShowPage } from './ShowPage';

export function ItemPage({ route }: { route: Extract<Route, { kind: 'item' }> }) {
  const { plex, t } = useApp();
  const { byId } = useServers();
  const nav = useNav();
  const server = byId(route.serverId);
  const resource = useResource(server ? `item:${route.serverId}:${route.ratingKey}` : null, () =>
    fetchItem(plex, server!, route.ratingKey),
  );
  const item = resource.data;
  const pageAction = useRef<((action: Action) => boolean) | null>(null);
  const onAction = useCallback((action: Action) => pageAction.current?.(action) ?? false, []);

  return (
    <FocusScope className="page item-page" onBack={nav.pop} onAction={onAction}>
      <Backdrop item={item ?? null} className="page-backdrop" />
      {!item ? (
        <p className="page-message muted">{resource.error ? t('item.loadFailed') : t('app.loading')}</p>
      ) : (
        <div className="item-scroll" data-scroll="y">
          <div className="scroll-content">
            {item.type === 'show' ? (
              <ShowPage show={item} route={route} actions={pageAction} />
            ) : (
              <>
                <div className="item-body" data-scroll-block="">
                  <ItemHeading item={item} badges={qualityBadges(item)} />
                  {item.tagline && <p className="item-tagline">{item.tagline}</p>}
                  {item.summary && <p className="item-summary">{item.summary}</p>}
                  <Credits item={item} />
                  <ItemActions item={item} autoFocus />
                </div>
                <MediaInfo item={item} />
              </>
            )}
          </div>
        </div>
      )}
    </FocusScope>
  );
}
