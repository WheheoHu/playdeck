import { createContext, useContext } from 'react';
import type { PlayDeckBridge, Settings } from '../../shared/bridge';
import type { Translate } from '../core/i18n';
import type { PlexContext } from '../core/plex/client';

declare global {
  interface Window {
    playdeck: PlayDeckBridge;
  }
}

export interface AppServices {
  bridge: PlayDeckBridge;
  plex: PlexContext;
  settings: Settings;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  t: Translate;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const services = useContext(AppContext);
  if (!services) throw new Error('useApp outside AppContext');
  return services;
}
