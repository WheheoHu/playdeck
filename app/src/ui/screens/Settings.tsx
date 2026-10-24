import type {
  AudioLanguage,
  LanguageSetting,
  SubtitleBackground,
  SubtitleColor,
  SubtitleLanguage,
} from '../../../shared/bridge';
import { LOCALES, type MessageKey } from '../../core/i18n';
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

          <OptionGroup
            title={t('settings.uiScale')}
            value={settings.uiScale}
            options={UI_SCALES.map((scale) => [scale, `${scale}%`])}
            onSelect={(uiScale) => updateSettings({ uiScale })}
          />

          <PlaybackSettings />

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
