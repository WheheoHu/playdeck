import type { LanguageSetting } from '../../../shared/bridge';
import { type MessageKey, type Messages, en } from './en';
import { zhCN } from './zh-CN';

export type Locale = 'en' | 'zh-CN';
export type { MessageKey };

export const LOCALES: Record<Locale, { name: string; messages: Messages }> = {
  en: { name: 'English', messages: en },
  'zh-CN': { name: '简体中文', messages: zhCN },
};

export function resolveLocale(setting: LanguageSetting, systemLocale: string): Locale {
  if (setting !== 'system') return setting;
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function translator(locale: Locale): Translate {
  const messages = LOCALES[locale].messages;
  return (key, params) =>
    messages[key].replace(/\{(\w+)\}/g, (match, name: string) => (params && name in params ? String(params[name]) : match));
}
