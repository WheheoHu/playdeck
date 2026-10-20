import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaItem } from '../../core/plex/library';
import { setWatched } from '../../core/plex/library';
import type { Session } from '../../core/session';
import { useApp } from '../AppContext';
import { Avatar } from '../components/Avatar';
import { Glyph } from '../components/Hints';
import { FocusButton, FocusScope, useFocusManager } from '../focus/react';
import { HomeScreen } from '../home/HomeScreen';
import type { Action } from '../input';
import { ContextMenu } from '../item/ContextMenu';
import { ItemPage } from '../item/ItemPage';
import { LibrariesScreen } from '../library/LibrariesScreen';
import { LibraryPage } from '../library/LibraryPage';
import { type Nav, NavContext, type Route, type Tab, TABS, isWatched, routeFor } from '../nav';
import { invalidate } from '../resource';
import { SearchScreen } from '../search/SearchScreen';
import { useServers } from '../servers';

const TOAST_MS = 2500;

const SHELL_HINTS = { menu: 'hint.settings' };

function TabBar({ tab, onTab, session }: { tab: Tab; onTab: (tab: Tab) => void; session: Session }) {
  const { t } = useApp();
  return (
    <nav className="tab-bar">
      <Glyph button="lb" />
      {TABS.map((name) => (
        <FocusButton key={name} className={name === tab ? 'tab active' : 'tab'} onSelect={() => onTab(name)}>
          {t(`tabs.${name}`)}
        </FocusButton>
      ))}
      <Glyph button="rb" />
      <div className="tab-bar-user">
        <span>{session.user.title}</span>
        <Avatar name={session.user.title} src={session.user.thumb} size={36} />
      </div>
    </nav>
  );
}

function Page({ route, hidden }: { route: Route; hidden: boolean }) {
  return (
    <div className="page-layer" style={hidden ? { visibility: 'hidden' } : undefined}>
      {route.kind === 'item' ? <ItemPage route={route} /> : <LibraryPage section={route.section} />}
    </div>
  );
}

export function MainShell({ session }: { session: Session }) {
  const { plex, t } = useApp();
  const { byId } = useServers();
  const manager = useFocusManager();
  const [tab, setTabState] = useState<Tab>('home');
  const setTab = useCallback(
    (next: Tab | ((current: Tab) => Tab)) => {
      manager.resetInitial();
      setTabState(next);
    },
    [manager],
  );
  const [stack, setStack] = useState<Route[]>([]);
  const [menuItem, setMenuItem] = useState<MediaItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const toggleWatched = useCallback(
    (item: MediaItem) => {
      const server = byId(item.serverId);
      if (!server) return;
      const watched = !isWatched(item);
      setWatched(plex, server, item.ratingKey, watched).then(
        () => {
          for (const prefix of ['home:', `item:${item.serverId}:`, `children:${item.serverId}:`, 'search:']) invalidate(prefix);
          setToast(t(watched ? 'item.watchedDone' : 'item.unwatchedDone'));
        },
        (reason: unknown) => setToast(t('item.actionFailed', { message: String(reason) })),
      );
    },
    [byId, plex, t],
  );

  const nav = useMemo<Nav>(
    () => ({
      tab,
      setTab,
      push: (route) => setStack((current) => [...current, route]),
      pop: () => setStack((current) => current.slice(0, -1)),
      open: (item) => setStack((current) => [...current, routeFor(item)]),
      menu: setMenuItem,
      toggleWatched,
      toast: setToast,
    }),
    [tab, setTab, toggleWatched],
  );

  const onShellAction = useCallback((action: Action) => {
    if (action === 'previous-tab' || action === 'next-tab') {
      setTab((current) => TABS[(TABS.indexOf(current) + (action === 'next-tab' ? 1 : TABS.length - 1)) % TABS.length]);
      return true;
    }
    return false;
  }, [setTab]);

  return (
    <NavContext.Provider value={nav}>
      <FocusScope className="shell" onAction={onShellAction} hints={SHELL_HINTS} hidden={stack.length > 0}>
        <TabBar tab={tab} onTab={setTab} session={session} />
        <div className="tab-content">
          {tab === 'home' && <HomeScreen />}
          {tab === 'libraries' && <LibrariesScreen />}
          {tab === 'search' && <SearchScreen />}
        </div>
      </FocusScope>
      {stack.map((route, index) => (
        <Page key={index} route={route} hidden={index < stack.length - 1} />
      ))}
      {menuItem && <ContextMenu item={menuItem} here={stack.at(-1)} onClose={() => setMenuItem(null)} />}      {toast && <div className="toast">{toast}</div>}
    </NavContext.Provider>
  );
}
