/**
 * Contract between the web layer and its host (docs/DESIGN.md, section 3.2).
 *
 * Electron's main process implements it today; a native host may replace Electron later (Path B), so
 * everything the UI needs from the system goes through this interface and nothing else.
 */
export const BRIDGE_VERSION = 2;

export type LanguageSetting = 'system' | 'en' | 'zh-CN';

export interface ManualServer {
  url: string;
}

export type LibrarySort = 'title' | 'added' | 'released' | 'rating' | 'watched';

/** User-editable settings, stored as human-readable JSON. */
export interface Settings {
  language: LanguageSetting;
  manualServers: ManualServer[];
  /** Libraries whose items stay off Home, as `${serverId}/${sectionKey}`. */
  homeHiddenLibraries: string[];
  /** Grid order per library, keyed like homeHiddenLibraries. */
  librarySort: Record<string, LibrarySort>;
  /** On the internal panel, run at a multiple of the video's frame rate during playback. */
  refreshSwitching: boolean;
  hardwareDecoding: boolean;
  /** Skip intro and credits markers without asking. */
  autoSkipMarkers: boolean;
  autoplayNext: boolean;
  /** Keep the network panel (download speed, buffer) on screen during playback. */
  networkMonitor: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'system',
  manualServers: [],
  homeHiddenLibraries: [],
  librarySort: {},
  refreshSwitching: true,
  hardwareDecoding: true,
  autoSkipMarkers: false,
  autoplayNext: true,
  networkMonitor: false,
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

export interface HomeUser {
  uuid: string;
  title: string;
  thumb?: string;
  admin: boolean;
  restricted: boolean;
  guest: boolean;
  /** A PIN is required to switch to this user. */
  protected: boolean;
}

export interface PlexConnection {
  uri: string;
  protocol: 'http' | 'https';
  address: string;
  port: number;
  local: boolean;
  relay: boolean;
  ipv6: boolean;
}

export interface PlexServer {
  name: string;
  clientIdentifier: string;
  accessToken: string;
  owned: boolean;
  productVersion?: string;
  connections: PlexConnection[];
}

/**
 * Secrets, stored separately from settings with owner-only permissions. Besides the tokens it keeps
 * what plex.tv last said, so a returning user gets in without waiting for plex.tv.
 */
export interface Credentials {
  account?: PlexAccount;
  user?: PlexUserSession;
  homeUsers?: HomeUser[];
  /** The user's servers with their access tokens. */
  servers?: { userUuid: string; list: PlexServer[] };
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

/** An audio or subtitle track as the OSD offers it; `id` is the Plex stream ID. */
export interface SessionTrack {
  id: number;
  kind: 'audio' | 'subtitle';
  title: string;
  language?: string;
  /** The stream's index in the container, which mpv reports as `ff-index`. Absent for sidecar files. */
  ffIndex?: number;
  /** A sidecar subtitle file, fetched with the session's headers. */
  url?: string;
  selected: boolean;
}

/** Seconds into the video. */
export interface SessionMarker {
  kind: 'intro' | 'credits';
  start: number;
  end: number;
}

/**
 * One video for mpv, built by the web layer. The host hands it to the PlayDeck mpv script in a file
 * that only the user can read, so the token in `httpHeaders` never appears on a command line.
 */
export interface PlaySession {
  /** Direct Play URL, without credentials. */
  url: string;
  httpHeaders: string[];
  /** Seconds. */
  start: number;
  title: string;
  /** A second line, e.g. "S1 · E4 · Pilot". */
  subtitle?: string;
  /** The server's frame rate, used until mpv reports the container's. */
  frameRate?: number;
  /** The file's average bit rate as the server reports it, in kbps; the network panel compares against it. */
  bitrate?: number;
  tracks: SessionTrack[];
  markers: SessionMarker[];
  /** The episode that follows, for the "next episode" card. */
  next?: { title: string; subtitle?: string };
  autoSkipMarkers: boolean;
  autoplayNext: boolean;
  networkMonitor: boolean;
  /** OSD text in the UI language; `{n}`, `{time}`, `{rate}` and `{size}` are filled in by the script. */
  strings: Record<string, string>;
}

export interface PlayerOptions {
  hardwareDecoding: boolean;
  refreshSwitching: boolean;
  /** mpv key bindings, generated from the key mapping. */
  inputConf: string;
}

export type PlayerEvent =
  /** The first frame is on screen and the UI window is hidden. */
  | { type: 'playing' }
  /** At most once a second while playing, and on every pause, resume and seek. Seconds. */
  | { type: 'progress'; position: number; duration: number; paused: boolean }
  /** The viewer picked a track in the OSD: Plex stream IDs, subtitle 0 for off, absent if unchanged. */
  | { type: 'tracks'; audio?: number; subtitle?: number }
  /** The OSD wants the next episode, because the viewer asked or the countdown ran out. */
  | { type: 'next' }
  /** The viewer turned the network panel on or off in the OSD's playback menu. */
  | { type: 'networkMonitor'; on: boolean }
  /** mpv exited and the UI window is back. */
  | { type: 'ended'; position: number; duration: number; reachedEnd: boolean; error?: string };

export interface PlayerBridge {
  /** Starts mpv on a session. Resolves once mpv runs; progress arrives as events. */
  start(session: PlaySession, options: PlayerOptions): Promise<void>;
  /** Replaces the video in the running mpv, e.g. with the next episode. */
  next(session: PlaySession): Promise<void>;
  stop(): void;
  onEvent(listener: (event: PlayerEvent) => void): () => void;
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
  player: PlayerBridge;
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
  playerStart: 'playdeck:player:start',
  playerNext: 'playdeck:player:next',
  playerStop: 'playdeck:player:stop',
  playerEvent: 'playdeck:player:event',
} as const;
