/**
 * Contract between the web layer and its host (docs/DESIGN.md, section 3.2).
 *
 * Electron's main process implements it today; a native host may replace Electron later (Path B), so
 * everything the UI needs from the system goes through this interface and nothing else.
 */
export const BRIDGE_VERSION = 1;

export type LanguageSetting = 'system' | 'en' | 'zh-CN';

export interface ManualServer {
  url: string;
}

/** User-editable settings, stored as human-readable JSON. */
export interface Settings {
  language: LanguageSetting;
  manualServers: ManualServer[];
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'system',
  manualServers: [],
};

export interface PlexAccount {
  uuid: string;
  username: string;
  title: string;
  thumb?: string;
  token: string;
}

/** The Plex Home user PlayDeck acts as. For accounts without Plex Home this is the account itself. */
export interface PlexUserSession {
  uuid: string;
  title: string;
  thumb?: string;
  token: string;
}

/** Secrets, stored separately from settings with owner-only permissions. */
export interface Credentials {
  account?: PlexAccount;
  user?: PlexUserSession;
}

export interface RememberedConnection {
  url: string;
  networkClass: 'local' | 'remote';
}

/** Disposable state that only speeds things up; losing it is harmless. */
export interface AppCache {
  connections: Record<string, RememberedConnection>;
}

export const DEFAULT_CACHE: AppCache = { connections: {} };

export interface AppInfo {
  version: string;
  platform: string;
  platformVersion: string;
  device: string;
  deviceName: string;
  clientIdentifier: string;
  locale: string;
}

export interface PlayDeckBridge {
  readonly version: number;
  getAppInfo(): Promise<AppInfo>;
  readSettings(): Promise<Settings>;
  writeSettings(settings: Settings): Promise<void>;
  readCredentials(): Promise<Credentials>;
  writeCredentials(credentials: Credentials): Promise<void>;
  readCache(): Promise<AppCache>;
  writeCache(cache: AppCache): Promise<void>;
  quit(): void;
}

export const CHANNELS = {
  appInfo: 'playdeck:app-info',
  readSettings: 'playdeck:settings:read',
  writeSettings: 'playdeck:settings:write',
  readCredentials: 'playdeck:credentials:read',
  writeCredentials: 'playdeck:credentials:write',
  readCache: 'playdeck:cache:read',
  writeCache: 'playdeck:cache:write',
  quit: 'playdeck:quit',
} as const;
