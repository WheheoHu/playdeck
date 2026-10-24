import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AppInfo,
  Credentials,
  PlexAccount,
  PlexServer,
  PlexUserSession,
  Settings,
  WebDavLibraryConfig,
} from '../../shared/bridge';
import { resolveLocale, translator } from '../core/i18n';
import type { PlexContext } from '../core/plex/client';
import type { HomeUser } from '../core/plex/home';
import { type RestoredSession, type Session, afterSignIn, restoreSession, resumeSession } from '../core/session';
import { AppContext, type AppServices } from './AppContext';
import { HintsBar } from './components/Hints';
import { FocusProvider } from './focus/react';
import type { Action } from './input';
import { SettingsOverlay } from './screens/Settings';
import { SignInScreen } from './screens/SignIn';
import { UserPickerScreen } from './screens/UserPicker';
import { ServersProvider } from './servers';
import { MainShell } from './shell/MainShell';

type Phase =
  | { name: 'booting' }
  | { name: 'signed-out'; returnTo?: Session }
  | { name: 'choose-user'; account: PlexAccount; users: HomeUser[]; returnTo?: Session }
  | { name: 'ready'; session: Session }
  | { name: 'failed'; message: string };

interface Boot {
  app: AppInfo;
  settings: Settings;
  credentials: Credentials;
}

const bridge = window.playdeck;

function webdavOnlySession(): Session {
  const local = { uuid: 'webdav-local', title: 'WebDAV', token: '' };
  return {
    account: { ...local, username: 'WebDAV' },
    user: local,
    homeUsers: [],
  };
}

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [webdavLibraries, setWebdavLibraries] = useState<WebDavLibraryConfig[]>([]);
  const [phase, setPhase] = useState<Phase>({ name: 'booting' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const credentials = useRef<Credentials>({});

  const saveCredentials = useCallback((next: Credentials) => {
    credentials.current = next;
    return bridge.writeCredentials(next);
  }, []);

  useEffect(() => {
    Promise.all([bridge.getAppInfo(), bridge.readSettings(), bridge.readCredentials()]).then(
      ([app, loadedSettings, loadedCredentials]) => {
        credentials.current = loadedCredentials;
        setWebdavLibraries(loadedCredentials.webdavLibraries ?? []);
        setBoot({ app, settings: loadedSettings, credentials: loadedCredentials });
        setSettings(loadedSettings);
      },
      (reason: unknown) => setPhase({ name: 'failed', message: String(reason) }),
    );
  }, []);

  const plex = useMemo<PlexContext | null>(() => (boot ? { app: boot.app, fetch: (...args) => fetch(...args) } : null), [boot]);

  const applyRestored = useCallback(
    async (restored: RestoredSession) => {
      const current = credentials.current;
      const webdav = current.webdavLibraries ?? [];
      if (restored.kind === 'signed-out') {
        await saveCredentials(webdav.length > 0 ? { webdavLibraries: webdav } : {});
        if (webdav.length > 0) {
          setPhase({ name: 'ready', session: webdavOnlySession() });
        } else {
          setPhase({ name: 'signed-out' });
        }
      } else if (restored.kind === 'choose-user') {
        await saveCredentials({ ...current, account: restored.account, user: undefined, homeUsers: restored.users });
        setPhase({ name: 'choose-user', account: restored.account, users: restored.users });
      } else {
        const { account, user, homeUsers } = restored.session;
        await saveCredentials({ ...current, account, user, homeUsers });
        setPhase({ name: 'ready', session: restored.session });
      }
    },
    [saveCredentials],
  );

  useEffect(() => {
    if (!boot || !plex) return;
    const resumed =
      resumeSession(boot.credentials) ??
      ((boot.credentials.webdavLibraries?.length ?? 0) > 0 ? webdavOnlySession() : null);
    const resumedPhase: Phase | null = resumed && { name: 'ready', session: resumed };
    if (resumedPhase) setPhase(resumedPhase);
    restoreSession(plex, boot.credentials).then(
      (restored) => {
        // The user may have switched users, added WebDAV, or signed out while plex.tv was answering.
        if (resumedPhase && phaseRef.current !== resumedPhase) return;
        return applyRestored(restored);
      },
      (reason: unknown) => setPhase({ name: 'failed', message: String(reason) }),
    );
  }, [boot, plex, applyRestored]);

  const onServers = useCallback(
    (userUuid: string, list: PlexServer[]) => {
      const current = credentials.current;
      if (JSON.stringify(current.servers) === JSON.stringify({ userUuid, list })) return;
      void saveCredentials({ ...current, servers: { userUuid, list } });
    },
    [saveCredentials],
  );

  const onSignedIn = useCallback(
    (account: PlexAccount) => {
      if (!plex) return;
      afterSignIn(plex, account)
        .then(applyRestored)
        .catch((reason: unknown) => setPhase({ name: 'failed', message: String(reason) }));
    },
    [plex, applyRestored],
  );

  const onUserChosen = useCallback(
    async (user: PlexUserSession) => {
      if (phase.name !== 'choose-user') return;
      await applyRestored({ kind: 'ready', session: { account: phase.account, user, homeUsers: phase.users } });
    },
    [phase, applyRestored],
  );

  const addWebDavLibrary = useCallback(
    async (config: WebDavLibraryConfig) => {
      const current = credentials.current;
      const nextList = [...(current.webdavLibraries ?? []), config];
      setWebdavLibraries(nextList);
      await saveCredentials({ ...current, webdavLibraries: nextList });
      if (phaseRef.current.name !== 'ready') {
        setPhase({ name: 'ready', session: webdavOnlySession() });
      }
    },
    [saveCredentials],
  );

  const removeWebDavLibrary = useCallback(
    async (id: string) => {
      const current = credentials.current;
      const nextList = (current.webdavLibraries ?? []).filter((lib) => lib.id !== id);
      setWebdavLibraries(nextList);
      await saveCredentials({ ...current, webdavLibraries: nextList });
      if (nextList.length === 0 && !current.account?.token) {
        setSettingsOpen(false);
        setPhase({ name: 'signed-out' });
      }
    },
    [saveCredentials],
  );

  useLayoutEffect(() => {
    if (settings) bridge.setUiScale(settings.uiScale);
  }, [settings?.uiScale]);

  const services = useMemo<AppServices | null>(() => {
    if (!boot || !plex || !settings) return null;
    return {
      bridge,
      plex,
      settings,
      t: translator(resolveLocale(settings.language, boot.app.locale)),
      async updateSettings(patch) {
        const next = { ...settings, ...patch };
        setSettings(next);
        await bridge.writeSettings(next);
      },
    };
  }, [boot, plex, settings]);

  const onUnhandled = useCallback(
    (action: Action) => {
      if (action === 'menu' && phase.name === 'ready') setSettingsOpen((open) => !open);
    },
    [phase.name],
  );

  if (phase.name === 'failed') return <div className="screen centered error">{phase.message}</div>;
  if (!services) return <div className="screen centered muted">…</div>;
  const { t } = services;

  return (
    <AppContext.Provider value={services}>
      <FocusProvider onUnhandled={onUnhandled}>
        {phase.name === 'booting' && <div className="screen centered muted">{t('app.loading')}</div>}
        {phase.name === 'signed-out' && (
          <SignInScreen
            onSignedIn={onSignedIn}
            onAddWebDav={addWebDavLibrary}
            onCancel={phase.returnTo ? () => setPhase({ name: 'ready', session: phase.returnTo! }) : undefined}
          />
        )}
        {phase.name === 'choose-user' && (
          <UserPickerScreen
            account={phase.account}
            users={phase.users}
            onChosen={onUserChosen}
            onBack={phase.returnTo ? () => setPhase({ name: 'ready', session: phase.returnTo! }) : undefined}
          />
        )}
        {phase.name === 'ready' && (
          <ServersProvider
            key={phase.session.user.uuid}
            session={phase.session}
            webdavLibraries={webdavLibraries}
            cached={credentials.current.servers?.userUuid === phase.session.user.uuid ? credentials.current.servers.list : undefined}
            onServers={onServers}
          >
            <MainShell session={phase.session} />
            {settingsOpen && (
              <SettingsOverlay
                session={phase.session}
                webdavLibraries={webdavLibraries}
                onAddWebDav={addWebDavLibrary}
                onRemoveWebDav={removeWebDavLibrary}
                onClose={() => setSettingsOpen(false)}
                onSwitchUser={() => {
                  setSettingsOpen(false);
                  const { session } = phase;
                  setPhase({ name: 'choose-user', account: session.account, users: session.homeUsers, returnTo: session });
                }}
                onSignOut={async () => {
                  setSettingsOpen(false);
                  const webdav = credentials.current.webdavLibraries ?? [];
                  await saveCredentials(webdav.length > 0 ? { webdavLibraries: webdav } : {});
                  if (webdav.length > 0) {
                    setPhase({ name: 'ready', session: webdavOnlySession() });
                  } else {
                    setPhase({ name: 'signed-out' });
                  }
                }}
                onSignInPlex={() => {
                  setSettingsOpen(false);
                  setPhase({ name: 'signed-out', returnTo: phase.session });
                }}
              />
            )}
          </ServersProvider>
        )}
        <HintsBar />
      </FocusProvider>
    </AppContext.Provider>
  );
}
