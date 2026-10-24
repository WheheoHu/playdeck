import { useEffect, useState } from 'react';
import type { PlexAccount, WebDavLibraryConfig } from '../../../shared/bridge';
import { LINK_URL } from '../../core/plex/auth';
import { type SignInState, runSignIn } from '../../core/signIn';
import { useApp } from '../AppContext';
import { QrCode } from '../components/QrCode';
import { FocusButton, FocusScope } from '../focus/react';
import { WebDavSetupModal } from './WebDavSetup';

function useCountdown(until: number | undefined): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  const seconds = Math.max(0, Math.round(((until ?? now) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SignInScreen({
  onSignedIn,
  onAddWebDav,
  onCancel,
}: {
  onSignedIn: (account: PlexAccount) => void;
  onAddWebDav: (config: WebDavLibraryConfig) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const { plex, bridge, t } = useApp();
  const [state, setState] = useState<SignInState>({ status: 'creating' });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [addingWebDav, setAddingWebDav] = useState(false);
  const countdown = useCountdown(state.status === 'waiting' ? state.expiresAt : undefined);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    runSignIn(plex, setState, controller.signal).then(onSignedIn, (reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [plex, onSignedIn, attempt]);

  return (
    <FocusScope className="screen sign-in" onBack={onCancel}>
      <h1>{t('signIn.title')}</h1>
      {error ? (
        <div className="sign-in-body">
          <p className="error">{t('app.error', { message: error })}</p>
          <FocusButton autoFocus onSelect={() => setAttempt((n) => n + 1)}>
            {t('app.retry')}
          </FocusButton>
        </div>
      ) : state.status === 'waiting' ? (
        <div className="sign-in-body">
          <div className="sign-in-qr">
            <QrCode value={state.qrUrl} />
            <p>{t('signIn.scan')}</p>
          </div>
          <div className="sign-in-or">{t('signIn.or')}</div>
          <div className="sign-in-code">
            <p>{t('signIn.visit', { url: LINK_URL.replace('https://', '') })}</p>
            <div className="link-code">{state.linkCode}</div>
            <p className="muted">{t('signIn.expires', { time: countdown })}</p>
          </div>
        </div>
      ) : (
        <div className="sign-in-body">
          <p className="muted">{t(state.status === 'creating' ? 'signIn.creating' : 'signIn.signingIn')}</p>
        </div>
      )}
      <div className="screen-footer">
        {state.status === 'waiting' && !error && <p className="muted">{t('signIn.waiting')}</p>}
        <FocusButton onSelect={() => setAddingWebDav(true)}>{t('signIn.addWebDav')}</FocusButton>
        {onCancel ? (
          <FocusButton onSelect={onCancel}>{t('hint.back')}</FocusButton>
        ) : (
          <FocusButton onSelect={() => bridge.quit()}>{t('app.quit')}</FocusButton>
        )}
      </div>
      {addingWebDav && <WebDavSetupModal onAdd={onAddWebDav} onClose={() => setAddingWebDav(false)} />}
    </FocusScope>
  );
}
