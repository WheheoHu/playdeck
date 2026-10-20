import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppInfo, Credentials, PlexAccount, PlexUserSession, Settings } from '../../shared/bridge';
import { resolveLocale, translator } from '../core/i18n';
import type { PlexContext } from '../core/plex/client';
import type { HomeUser } from '../core/plex/home';
import { type RestoredSession, type Session, afterSignIn, restoreSession } from '../core/session';
import { AppContext, type AppServices } from './AppContext';
import { FocusProvider } from './focus/react';
import type { Action } from './input';
import { SettingsOverlay } from './screens/Settings';
import { SignInScreen } from './screens/SignIn';
import { UserPickerScreen } from './screens/UserPicker';
import { ServersProvider } from './servers';
import { MainShell } from './shell/MainShell';

type Phase =
  | { name: 'booting' }
  | { name: 'signed-out' }
  | { name: 'choose-user'; account: PlexAccount; users: HomeUser[]; returnTo?: Session }
  | { name: 'ready'; session: Session }
  | { name: 'failed'; message: string };

interface Boot {
  app: AppInfo;
  settings: Settings;
  credentials: Credentials;
}

const bridge = window.playdeck;

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'booting' });
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    Promise.all([bridge.getAppInfo(), bridge.readSettings(), bridge.readCredentials()]).then(
      ([app, loadedSettings, credentials]) => {
        setBoot({ app, settings: loadedSettings, credentials });
        setSettings(loadedSettings);
      },
      (reason: unknown) => setPhase({ name: 'failed', message: String(reason) }),
    );
  }, []);

  const plex = useMemo<PlexContext | null>(() => (boot ? { app: boot.app, fetch: (...args) => fetch(...args) } : null), [boot]);

  const applyRestored = useCallback(async (restored: RestoredSession, account?: PlexAccount) => {
    if (restored.kind === 'signed-out') {
      await bridge.writeCredentials({});
      setPhase({ name: 'signed-out' });
    } else if (restored.kind === 'choose-user') {
      await bridge.writeCredentials({ account: restored.account });
      setPhase({ name: 'choose-user', account: restored.account, users: restored.users });
    } else {
      await bridge.writeCredentials({ account: account ?? restored.session.account, user: restored.session.user });
      setPhase({ name: 'ready', session: restored.session });
    }
  }, []);

  useEffect(() => {
    if (!boot || !plex) return;
    restoreSession(plex, boot.credentials).then(applyRestored, (reason: unknown) =>
      setPhase({ name: 'failed', message: String(reason) }),
    );
  }, [boot, plex, applyRestored]);

  const onSignedIn = useCallback(
    (account: PlexAccount) => {
      if (!plex) return;
      afterSignIn(plex, account)
        .then((restored) => applyRestored(restored, account))
        .catch((reason: unknown) => setPhase({ name: 'failed', message: String(reason) }));
    },
    [plex, applyRestored],
  );

  const onUserChosen = useCallback(
    async (user: PlexUserSession) => {
      if (phase.name !== 'choose-user') return;
      await bridge.writeCredentials({ account: phase.account, user });
      setPhase({ name: 'ready', session: { account: phase.account, user, homeUsers: phase.users } });
    },
    [phase],
  );

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
        {phase.name === 'signed-out' && <SignInScreen onSignedIn={onSignedIn} />}
        {phase.name === 'choose-user' && (
          <UserPickerScreen
            account={phase.account}
            users={phase.users}
            onChosen={onUserChosen}
            onBack={phase.returnTo ? () => setPhase({ name: 'ready', session: phase.returnTo! }) : undefined}
          />
        )}
        {phase.name === 'ready' && (
          <ServersProvider key={phase.session.user.uuid} session={phase.session}>
            <MainShell session={phase.session} />
            {settingsOpen && (
              <SettingsOverlay
                session={phase.session}
                onClose={() => setSettingsOpen(false)}
                onSwitchUser={() => {
                  setSettingsOpen(false);
                  const { session } = phase;
                  setPhase({ name: 'choose-user', account: session.account, users: session.homeUsers, returnTo: session });
                }}
                onSignOut={async () => {
                  setSettingsOpen(false);
                  await bridge.writeCredentials({});
                  setPhase({ name: 'signed-out' });
                }}
              />
            )}
          </ServersProvider>
        )}
      </FocusProvider>
    </AppContext.Provider>
  );
}
