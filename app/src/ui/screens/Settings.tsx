import { useState } from 'react';
import type {
  AudioLanguage,
  LanguageSetting,
  SubtitleBackground,
  SubtitleColor,
  SubtitleLanguage,
  WebDavLibraryConfig,
} from '../../../shared/bridge';
import { LOCALES, type MessageKey } from '../../core/i18n';
import { libraryId } from '../../core/plex/library';
import type { Session } from '../../core/session';
import { getWebDavCatalog } from '../../core/webdav/scanner';
import { useApp } from '../AppContext';
import { FocusButton, FocusScope } from '../focus/react';
import { useSections } from '../library/LibrariesScreen';
import { useServers } from '../servers';
import { ServerStatusList } from './Servers';
import { WebDavSetupModal } from './WebDavSetup';

interface SettingsProps {
  session: Session;
  webdavLibraries: WebDavLibraryConfig[];
  onAddWebDav: (config: WebDavLibraryConfig) => Promise<void> | void;
  onRemoveWebDav: (id: string) => Promise<void> | void;
  onClose: () => void;
  onSwitchUser: () => void;
  onSignOut: () => void;
  onSignInPlex?: () => void;
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
              {section.isWebDav && <span className="webdav-badge">WebDAV</span>}
              {!section.isWebDav && online.length > 1 && (
                <span className="muted"> · {online.find((s) => s.id === section.serverId)?.name}</span>
              )}
            </FocusButton>
          );
        })}
        {!sections.data && <p className="muted">{t('app.loading')}</p>}
      </div>
    </>
  );
}

function WebDavLibrariesSection({
  libraries,
  onOpenAdd,
  onRemove,
}: {
  libraries: WebDavLibraryConfig[];
  onOpenAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useApp();
  const { rescanWebDav } = useServers();

  return (
    <>
      <h3>{t('settings.webdavLibraries')}</h3>
      <ul className="server-list">
        {libraries.length === 0 && <li className="muted">{t('webdav.empty')}</li>}
        {libraries.map((lib) => {
          const catalog = getWebDavCatalog(lib.id);
          const typeLabel = t(
            lib.type === 'movie' ? 'libraries.movies' : lib.type === 'show' ? 'libraries.shows' : 'libraries.mixed',
          );
          const status = catalog?.scanning
            ? t('webdav.scanningFolders', {
                scanned: catalog.scannedFolders,
                total: Math.max(catalog.totalFolders, catalog.scannedFolders),
              })
            : catalog?.error
              ? catalog.error
              : t('library.count', { count: catalog?.topItems.length ?? 0 });

          return (
            <li key={lib.id} className="server-row online webdav-server-row">
              <div>
                <div className="server-name">
                  {lib.name} <span className="webdav-badge">WebDAV</span>
                </div>
                <div className="muted">
                  {typeLabel} · {lib.baseUrl}
                  {lib.rootPath} · {status}
                </div>
              </div>
              <div className="webdav-row-actions">
                <FocusButton onSelect={() => rescanWebDav(lib.id)}>{t('webdav.rescan')}</FocusButton>
                <FocusButton onSelect={() => onRemove(lib.id)}>{t('webdav.remove')}</FocusButton>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="option-row">
        <FocusButton onSelect={onOpenAdd}>{t('webdav.add')}</FocusButton>
      </div>
    </>
  );
}

const UI_SCALES = [90, 100, 110, 125, 150] as const;
const SUBTITLE_SCALES = [75, 100, 125, 150] as const;
const HDR_BRIGHTNESS = [100, 150, 203, 300, 400] as const;

const AUDIO_LANGUAGES: [AudioLanguage, MessageKey][] = [
  ['', 'settings.lang.server'],
  ['ja', 'settings.lang.ja'],
  ['zh', 'settings.lang.zh'],
  ['en', 'settings.lang.en'],
  ['ko', 'settings.lang.ko'],
];

const SUBTITLE_LANGUAGES: [SubtitleLanguage, MessageKey][] = [
  ['', 'settings.lang.server'],
  ['off', 'settings.lang.off'],
  ['zh-Hans', 'settings.lang.zhHans'],
  ['zh-Hant', 'settings.lang.zhHant'],
  ['zh', 'settings.lang.zh'],
  ['en', 'settings.lang.en'],
  ['ja', 'settings.lang.ja'],
];

const SUBTITLE_COLORS: [SubtitleColor, MessageKey][] = [
  ['white', 'settings.subtitleColor.white'],
  ['yellow', 'settings.subtitleColor.yellow'],
  ['gray', 'settings.subtitleColor.gray'],
];

const SUBTITLE_BACKGROUNDS: [SubtitleBackground, MessageKey][] = [
  ['outline', 'settings.subtitleBackground.outline'],
  ['box', 'settings.subtitleBackground.box'],
  ['none', 'settings.subtitleBackground.none'],
];

type PlaybackSetting = 'refreshSwitching' | 'hardwareDecoding' | 'autoSkipMarkers' | 'autoplayNext' | 'networkMonitor';

const PLAYBACK_SETTINGS: [PlaybackSetting, MessageKey][] = [
  ['autoplayNext', 'settings.autoplayNext'],
  ['autoSkipMarkers', 'settings.autoSkipMarkers'],
  ['refreshSwitching', 'settings.refreshSwitching'],
  ['hardwareDecoding', 'settings.hardwareDecoding'],
  ['networkMonitor', 'settings.networkMonitor'],
];

function OptionGroup<T extends string | number>({
  title,
  note,
  value,
  options,
  onSelect,
}: {
  title: string;
  note?: string;
  value: T;
  options: [T, string][];
  onSelect: (next: T) => void;
}) {
  return (
    <>
      <h3>{title}</h3>
      {note && <p className="muted settings-note">{note}</p>}
      <div className="option-row">
        {options.map(([option, label]) => (
          <FocusButton
            key={String(option)}
            className={value === option ? 'option selected' : 'option'}
            onSelect={() => onSelect(option)}
          >
            {label}
          </FocusButton>
        ))}
      </div>
    </>
  );
}

function PlaybackSettings() {
  const { settings, updateSettings, t } = useApp();
  const subScales = SUBTITLE_SCALES.includes(settings.subtitleScale as (typeof SUBTITLE_SCALES)[number])
    ? [...SUBTITLE_SCALES]
    : [...SUBTITLE_SCALES, settings.subtitleScale].sort((a, b) => a - b);

  return (
    <>
      <OptionGroup
        title={t('settings.audioLanguage')}
        note={t('settings.tracksNote')}
        value={settings.audioLanguage}
        options={AUDIO_LANGUAGES.map(([code, key]) => [code, t(key)])}
        onSelect={(audioLanguage) => updateSettings({ audioLanguage })}
      />

      <OptionGroup
        title={t('settings.subtitleLanguage')}
        value={settings.subtitleLanguage}
        options={SUBTITLE_LANGUAGES.map(([code, key]) => [code, t(key)])}
        onSelect={(subtitleLanguage) => updateSettings({ subtitleLanguage })}
      />

      <OptionGroup
        title={t('settings.subtitleSize')}
        value={settings.subtitleScale}
        options={subScales.map((scale) => [scale, `${scale}%`])}
        onSelect={(subtitleScale) => updateSettings({ subtitleScale })}
      />

      <OptionGroup
        title={t('settings.subtitleColor')}
        value={settings.subtitleColor}
        options={SUBTITLE_COLORS.map(([color, key]) => [color, t(key)])}
        onSelect={(subtitleColor) => updateSettings({ subtitleColor })}
      />

      <OptionGroup
        title={t('settings.subtitleBackground')}
        value={settings.subtitleBackground}
        options={SUBTITLE_BACKGROUNDS.map(([bg, key]) => [bg, t(key)])}
        onSelect={(subtitleBackground) => updateSettings({ subtitleBackground })}
      />

      <OptionGroup
        title={t('settings.hdrBrightness')}
        value={settings.hdrSubtitleBrightness}
        options={HDR_BRIGHTNESS.map((nits) => [nits, `${nits} nits`])}
        onSelect={(hdrSubtitleBrightness) => updateSettings({ hdrSubtitleBrightness })}
      />

      <h3>{t('settings.playback')}</h3>
      <div className="option-row">
        {PLAYBACK_SETTINGS.map(([key, label]) => (
          <FocusButton
            key={key}
            className={settings[key] ? 'option toggle on' : 'option toggle'}
            onSelect={() => updateSettings({ [key]: !settings[key] })}
          >
            <span className="toggle-mark">{settings[key] ? '✓' : ''}</span>
            {t(label)}
          </FocusButton>
        ))}
      </div>
    </>
  );
}

export function SettingsOverlay({
  session,
  webdavLibraries,
  onAddWebDav,
  onRemoveWebDav,
  onClose,
  onSwitchUser,
  onSignOut,
  onSignInPlex,
}: SettingsProps) {
  const { plex, settings, updateSettings, t } = useApp();
  const [addingWebDav, setAddingWebDav] = useState(false);
  const hasPlexAccount = Boolean(session.account.token);
  const languages: [LanguageSetting, string][] = [
    ['system', t('settings.language.system')],
    ...Object.entries(LOCALES).map(([locale, { name }]) => [locale as LanguageSetting, name] as [LanguageSetting, string]),
  ];

  return (
    <FocusScope className="overlay" onBack={onClose} hints={SETTINGS_HINTS}>
      <div className="settings-panel" data-scroll="y">
        <div className="scroll-content">
          <h2>{t('settings.title')}</h2>
          <p className="muted">
            {hasPlexAccount ? t('settings.signedInAs', { name: session.account.title }) : t('settings.webdavOnlyMode')} · v
            {plex.app.version}
          </p>

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

          <OptionGroup
            title={t('settings.uiScale')}
            value={settings.uiScale}
            options={UI_SCALES.map((scale) => [scale, `${scale}%`])}
            onSelect={(uiScale) => updateSettings({ uiScale })}
          />

          <PlaybackSettings />

          <HomeLibraries />

          <WebDavLibrariesSection
            libraries={webdavLibraries}
            onOpenAdd={() => setAddingWebDav(true)}
            onRemove={(id) => void onRemoveWebDav(id)}
          />

          {hasPlexAccount && (
            <>
              <h3>{t('settings.servers')}</h3>
              <ServerStatusList />
            </>
          )}

          <div className="settings-actions">
            {session.homeUsers.length > 1 && <FocusButton onSelect={onSwitchUser}>{t('settings.switchUser')}</FocusButton>}
            {hasPlexAccount ? (
              <FocusButton onSelect={onSignOut}>{t('settings.signOut')}</FocusButton>
            ) : (
              onSignInPlex && <FocusButton onSelect={onSignInPlex}>{t('signIn.title')}</FocusButton>
            )}
          </div>
        </div>
      </div>
      {addingWebDav && <WebDavSetupModal onAdd={onAddWebDav} onClose={() => setAddingWebDav(false)} />}
    </FocusScope>
  );
}
