import type { LanguageSetting } from '../../../shared/bridge';
import { LOCALES } from '../../core/i18n';
import { libraryId } from '../../core/plex/library';
import type { Session } from '../../core/session';
import { useApp } from '../AppContext';
import { FocusButton, FocusScope } from '../focus/react';
import { useSections } from '../library/LibrariesScreen';
import { useServers } from '../servers';
import { ServerStatusList } from './Servers';

interface SettingsProps {
  session: Session;
  onClose: () => void;
  onSwitchUser: () => void;
  onSignOut: () => void;
}

const SETTINGS_HINTS = { b: 'hint.close' };

function HomeLibraries() {
  const { settings, updateSettings, t } = useApp();
  const sections = useSections();
  const { online } = useServers();
  const hidden = settings.homeHiddenLibraries;
  const toggle = (id: string) =>
    updateSettings({ homeHiddenLibraries: hidden.includes(id) ? hidden.filter((other) => other !== id) : [...hidden, id] });

  return (
    <>
      <h3>{t('settings.homeLibraries')}</h3>
      <p className="muted settings-note">{t('settings.homeLibrariesNote')}</p>
      <div className="option-row">
        {(sections.data ?? []).map((section) => {
          const id = libraryId(section);
          const shown = !hidden.includes(id);
          return (
            <FocusButton key={id} className={shown ? 'option toggle on' : 'option toggle'} onSelect={() => toggle(id)}>
              <span className="toggle-mark">{shown ? '✓' : ''}</span>
              {section.title}
              {online.length > 1 && <span className="muted"> · {online.find((s) => s.id === section.serverId)?.name}</span>}
            </FocusButton>
          );
        })}
        {!sections.data && <p className="muted">{t('app.loading')}</p>}
      </div>
    </>
  );
}

export function SettingsOverlay({ session, onClose, onSwitchUser, onSignOut }: SettingsProps) {
  const { settings, updateSettings, t } = useApp();
  const languages: [LanguageSetting, string][] = [
    ['system', t('settings.language.system')],
    ...Object.entries(LOCALES).map(([locale, { name }]) => [locale as LanguageSetting, name] as [LanguageSetting, string]),
  ];

  return (
    <FocusScope className="overlay" onBack={onClose} hints={SETTINGS_HINTS}>
      <div className="settings-panel" data-scroll="y">
        <div className="scroll-content">
          <h2>{t('settings.title')}</h2>
          <p className="muted">{t('settings.signedInAs', { name: session.account.title })}</p>

          <h3>{t('settings.language')}</h3>
          <div className="option-row">
            {languages.map(([value, label]) => (
              <FocusButton
                key={value}
                className={settings.language === value ? 'option selected' : 'option'}
                autoFocus={settings.language === value}
                onSelect={() => updateSettings({ language: value })}
              >
                {label}
              </FocusButton>
            ))}
          </div>

          <HomeLibraries />

          <h3>{t('settings.servers')}</h3>
          <ServerStatusList />

          <div className="settings-actions">
            {session.homeUsers.length > 1 && <FocusButton onSelect={onSwitchUser}>{t('settings.switchUser')}</FocusButton>}
            <FocusButton onSelect={onSignOut}>{t('settings.signOut')}</FocusButton>
          </div>
        </div>
      </div>
    </FocusScope>
  );
}
