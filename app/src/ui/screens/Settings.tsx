import type { LanguageSetting } from '../../../shared/bridge';
import { LOCALES } from '../../core/i18n';
import type { Session } from '../../core/session';
import { useApp } from '../AppContext';
import { FocusButton, FocusScope } from '../focus/react';
import { ServerStatusList } from './Servers';

interface SettingsProps {
  session: Session;
  onClose: () => void;
  onSwitchUser: () => void;
  onSignOut: () => void;
}

export function SettingsOverlay({ session, onClose, onSwitchUser, onSignOut }: SettingsProps) {
  const { settings, updateSettings, bridge, t } = useApp();
  const languages: [LanguageSetting, string][] = [
    ['system', t('settings.language.system')],
    ...Object.entries(LOCALES).map(([locale, { name }]) => [locale as LanguageSetting, name] as [LanguageSetting, string]),
  ];

  return (
    <FocusScope className="overlay" onBack={onClose}>
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

          <h3>{t('settings.servers')}</h3>
          <ServerStatusList />

          <div className="settings-actions">
            {session.homeUsers.length > 1 && <FocusButton onSelect={onSwitchUser}>{t('settings.switchUser')}</FocusButton>}
            <FocusButton onSelect={onSignOut}>{t('settings.signOut')}</FocusButton>
            <FocusButton onSelect={() => bridge.quit()}>{t('app.quit')}</FocusButton>
            <FocusButton onSelect={onClose}>{t('settings.close')}</FocusButton>
          </div>
        </div>
      </div>
    </FocusScope>
  );
}
