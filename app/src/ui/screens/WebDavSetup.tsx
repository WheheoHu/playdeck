import { useEffect, useState } from 'react';
import type { WebDavLibraryConfig, WebDavLibraryType } from '../../../shared/bridge';
import {
  type WebDavEntry,
  normalizeWebDavUrl,
  parentPath,
  propfind,
} from '../../core/webdav/client';
import { useApp } from '../AppContext';
import { FocusButton, FocusScope } from '../focus/react';
import type { Action } from '../input';

type SetupStep = 'connect' | 'folder' | 'type';
type FieldName = 'url' | 'username' | 'password' | 'name';

const LOWER_KEYS = [...'abcdefghijklmnopqrstuvwxyz0123456789.:/-_@'];
const UPPER_KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789?&=+%#'];
const QUICK_TOKENS = ['http://', 'https://', '192.168.', ':5244', ':5005', '/dav'];

const SETUP_HINTS = { b: 'hint.back' };

export interface WebDavSetupProps {
  onAdd: (config: WebDavLibraryConfig) => Promise<void> | void;
  onClose: () => void;
}

export function WebDavSetupModal({ onAdd, onClose }: WebDavSetupProps) {
  const { bridge, t } = useApp();
  const [step, setStep] = useState<SetupStep>('connect');
  const [activeField, setActiveField] = useState<FieldName>('url');
  const [shifted, setShifted] = useState(false);

  const [url, setUrl] = useState('http://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const [baseUrl, setBaseUrl] = useState('');
  const [currentPath, setCurrentPath] = useState('/');
  const [folders, setFolders] = useState<WebDavEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [libraryType, setLibraryType] = useState<WebDavLibraryType>('movie');

  const setFieldValue = (field: FieldName, updater: (prev: string) => string) => {
    setError(null);
    switch (field) {
      case 'url':
        setUrl(updater);
        break;
      case 'username':
        setUsername(updater);
        break;
      case 'password':
        setPassword(updater);
        break;
      case 'name':
        setName(updater);
        break;
    }
  };

  // Support physical keyboard typing and clipboard paste during Step 1.
  useEffect(() => {
    if (step !== 'connect') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        navigator.clipboard
          ?.readText()
          .then((clip) => {
            if (clip) setFieldValue(activeField, (prev) => prev + clip.trim());
          })
          .catch(() => {});
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length === 1) {
        setFieldValue(activeField, (prev) => prev + event.key);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step, activeField]);

  const deleteOnX = (action: Action) => {
    if (action !== 'context') return false;
    setFieldValue(activeField, (prev) => prev.slice(0, -1));
    return true;
  };

  const loadDirectory = async (targetBaseUrl: string, targetPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const entries = await propfind(
        (req) => bridge.webdavRequest(req),
        {
          baseUrl: targetBaseUrl,
          username: username.trim() || undefined,
          password: password || undefined,
        },
        targetPath,
      );
      setBaseUrl(targetBaseUrl);
      setCurrentPath(targetPath);
      setFolders(entries.filter((entry) => entry.isDirectory));
      setStep('folder');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = () => {
    if (loading) return;
    try {
      const normalized = normalizeWebDavUrl(url);
      void loadDirectory(normalized.baseUrl, normalized.rootPath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleConfirmFolder = () => {
    setStep('type');
  };

  const handleSave = async () => {
    const folderLabel = currentPath.split('/').filter(Boolean).pop();
    const hostLabel = (() => {
      try {
        return new URL(baseUrl).hostname;
      } catch {
        return 'WebDAV';
      }
    })();
    const finalName = name.trim() || folderLabel || hostLabel;
    const config: WebDavLibraryConfig = {
      id: `webdav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: finalName,
      baseUrl,
      rootPath: currentPath,
      username: username.trim() || undefined,
      password: password || undefined,
      type: libraryType,
    };
    await onAdd(config);
    onClose();
  };

  const handleBack = () => {
    if (step === 'type') {
      setStep('folder');
      return;
    }
    if (step === 'folder') {
      setStep('connect');
      return;
    }
    onClose();
  };

  const keys = shifted ? UPPER_KEYS : LOWER_KEYS;

  return (
    <FocusScope className="overlay" onBack={handleBack} hints={SETUP_HINTS}>
      <div className="webdav-setup-panel">
        <header className="webdav-setup-header">
          <h2>{t('webdav.setupTitle')}</h2>
          <div className="webdav-steps">
            <span className={step === 'connect' ? 'webdav-step active' : 'webdav-step'}>{t('webdav.stepConnect')}</span>
            <span className={step === 'folder' ? 'webdav-step active' : 'webdav-step'}>{t('webdav.stepFolder')}</span>
            <span className={step === 'type' ? 'webdav-step active' : 'webdav-step'}>{t('webdav.stepType')}</span>
          </div>
        </header>

        {step === 'connect' && (
          <div className="webdav-connect-body">
            <div className="webdav-fields">
              {(
                [
                  ['url', t('webdav.fieldUrl'), url || 'http://', false],
                  ['username', t('webdav.fieldUsername'), username || t('webdav.optional'), !username],
                  [
                    'password',
                    t('webdav.fieldPassword'),
                    password ? (activeField === 'password' ? password : '••••••••') : t('webdav.optional'),
                    !password,
                  ],
                  ['name', t('webdav.fieldName'), name || t('webdav.optional'), !name],
                ] as const
              ).map(([field, label, display, isMuted], idx) => (
                <FocusButton
                  key={field}
                  autoFocus={idx === 0}
                  className={activeField === field ? 'webdav-field active' : 'webdav-field'}
                  onSelect={() => setActiveField(field)}
                  onAction={deleteOnX}
                >
                  <span className="webdav-field-label">{label}</span>
                  <span className={isMuted ? 'webdav-field-value muted' : 'webdav-field-value'}>{display}</span>
                </FocusButton>
              ))}

              <FocusButton className="primary webdav-submit" onSelect={handleConnect}>
                {loading ? t('webdav.connecting') : t('webdav.connectNext')}
              </FocusButton>

              {error && <p className="error webdav-error">{error}</p>}
            </div>

            <div className="webdav-keyboard" data-hint-x="hint.delete">
              <div className="webdav-quick-row">
                {QUICK_TOKENS.map((token) => (
                  <FocusButton
                    key={token}
                    className="key webdav-token-key"
                    onSelect={() => setFieldValue(activeField, (prev) => prev + token)}
                    onAction={deleteOnX}
                  >
                    {token}
                  </FocusButton>
                ))}
              </div>
              <div className="keyboard-grid">
                {keys.map((char) => (
                  <FocusButton
                    key={char}
                    className="key"
                    onSelect={() => setFieldValue(activeField, (prev) => prev + char)}
                    onAction={deleteOnX}
                  >
                    {char}
                  </FocusButton>
                ))}
                <FocusButton
                  className={shifted ? 'key key-wide selected' : 'key key-wide'}
                  onSelect={() => setShifted((s) => !s)}
                  onAction={deleteOnX}
                >
                  {t('webdav.shift')}
                </FocusButton>
                <FocusButton
                  className="key key-wide"
                  onSelect={() => setFieldValue(activeField, (prev) => prev.slice(0, -1))}
                  onAction={deleteOnX}
                >
                  ⌫
                </FocusButton>
                <FocusButton
                  className="key key-wide"
                  onSelect={() => setFieldValue(activeField, () => '')}
                  onAction={deleteOnX}
                >
                  {t('search.clear')}
                </FocusButton>
              </div>
            </div>
          </div>
        )}

        {step === 'folder' && (
          <div className="webdav-folder-body" data-scroll="y">
            <div className="scroll-content webdav-folder-list">
              <FocusButton className="primary webdav-folder-confirm" autoFocus onSelect={handleConfirmFolder}>
                ✓ {t('webdav.useCurrentFolder', { path: currentPath })}
              </FocusButton>

              {currentPath !== '/' && (
                <FocusButton
                  className="menu-option"
                  onSelect={() => void loadDirectory(baseUrl, parentPath(currentPath))}
                >
                  <span>📁 {t('webdav.parentFolder')}</span>
                </FocusButton>
              )}

              {loading && <p className="muted">{t('webdav.connecting')}</p>}
              {error && <p className="error">{error}</p>}
              {!loading && folders.length === 0 && <p className="muted">{t('webdav.noSubfolders')}</p>}

              {folders.map((folder) => (
                <FocusButton
                  key={folder.path}
                  className="menu-option"
                  onSelect={() => void loadDirectory(baseUrl, folder.path)}
                >
                  <span>📁 {folder.name}</span>
                  <span className="muted">›</span>
                </FocusButton>
              ))}
            </div>
          </div>
        )}

        {step === 'type' && (
          <div className="webdav-type-body">
            <p className="muted">{t('webdav.typePrompt', { path: currentPath })}</p>
            <div className="option-row">
              {(
                [
                  ['movie', t('webdav.typeMovie')],
                  ['show', t('webdav.typeShow')],
                  ['mixed', t('webdav.typeMixed')],
                ] as [WebDavLibraryType, string][]
              ).map(([kind, label], idx) => (
                <FocusButton
                  key={kind}
                  autoFocus={idx === 0}
                  className={libraryType === kind ? 'option selected' : 'option'}
                  onSelect={() => setLibraryType(kind)}
                >
                  {label}
                </FocusButton>
              ))}
            </div>

            {libraryType === 'mixed' && <p className="webdav-mixed-warning">{t('webdav.mixedNote')}</p>}

            <div className="settings-actions">
              <FocusButton className="primary" onSelect={() => void handleSave()}>
                {t('webdav.saveAndScan')}
              </FocusButton>
            </div>
          </div>
        )}
      </div>
    </FocusScope>
  );
}
