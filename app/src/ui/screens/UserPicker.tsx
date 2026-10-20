import { useState } from 'react';
import type { PlexAccount, PlexUserSession } from '../../../shared/bridge';
import { type HomeUser, WrongPinError } from '../../core/plex/home';
import { chooseHomeUser } from '../../core/session';
import { useApp } from '../AppContext';
import { Avatar } from '../components/Avatar';
import { FocusButton, FocusScope } from '../focus/react';
import { PinEntry } from './PinEntry';

interface UserPickerProps {
  account: PlexAccount;
  users: HomeUser[];
  onChosen: (user: PlexUserSession) => void;
  onBack?: () => void;
}

export function UserPickerScreen({ account, users, onChosen, onBack }: UserPickerProps) {
  const { plex, t } = useApp();
  const [pinFor, setPinFor] = useState<HomeUser | null>(null);
  const [switching, setSwitching] = useState<HomeUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(user: HomeUser, pin?: string): Promise<boolean> {
    setSwitching(user);
    setError(null);
    try {
      onChosen(await chooseHomeUser(plex, account, user, pin));
      return true;
    } catch (reason) {
      if (reason instanceof WrongPinError) return false;
      setError(reason instanceof Error ? reason.message : String(reason));
      setPinFor(null);
      return true;
    } finally {
      setSwitching(null);
    }
  }

  return (
    <FocusScope className="screen users" onBack={onBack}>
      <h1>{t('users.title')}</h1>
      <div className="user-grid">
        {users.map((user, index) => (
          <FocusButton
            key={user.uuid}
            className="user-tile"
            autoFocus={index === 0}
            onSelect={() => (user.protected ? setPinFor(user) : void choose(user))}
          >
            <Avatar name={user.title} src={user.thumb} size={112} />
            <span className="user-name">{user.title}</span>
            <span className="muted user-note">{user.protected ? t('users.protected') : ' '}</span>
          </FocusButton>
        ))}
      </div>
      <p className="muted status-line">
        {switching ? t('users.switching', { name: switching.title }) : error ? t('app.error', { message: error }) : ' '}
      </p>
      {pinFor && (
        <PinEntry name={pinFor.title} onSubmit={(pin) => choose(pinFor, pin)} onCancel={() => setPinFor(null)} />
      )}
    </FocusScope>
  );
}
