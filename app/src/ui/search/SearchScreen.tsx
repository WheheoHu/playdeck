import { useEffect, useMemo, useState } from 'react';
import { episodeLabel } from '../../core/format';
import { type MediaItem, searchServer } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { type Row, Rows } from '../components/Rows';
import { FocusButton } from '../focus/react';
import { useNav } from '../nav';
import { useResource } from '../resource';
import { useServers } from '../servers';

const KEYS = [...'abcdefghijklmnopqrstuvwxyz1234567890'];
const DEBOUNCE_MS = 350;
const MIN_LENGTH = 2;

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function SearchScreen() {
  const { plex, t } = useApp();
  const { online } = useServers();
  const nav = useNav();
  const [query, setQuery] = useState('');
  const term = useDebounced(query.trim(), DEBOUNCE_MS);
  const key = online.map((server) => server.id).sort().join(',');

  // A physical keyboard types directly; Backspace stays mapped to Back.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.length === 1 && /[\p{L}\p{N} ]/u.test(event.key)) setQuery((value) => value + event.key.toLowerCase());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useResource(term.length >= MIN_LENGTH && key ? `search:${key}:${term}` : null, async () =>
    (await Promise.all(online.map((server) => searchServer(plex, server, term).catch(() => [] as MediaItem[])))).flat(),
  );

  const rows = useMemo<Row[]>(() => {
    const groups: [string, MediaItem['type']][] = [
      [t('search.movies'), 'movie'],
      [t('search.shows'), 'show'],
      [t('search.episodes'), 'episode'],
    ];
    return groups.flatMap(([title, type]) => {
      const items = (results.data ?? []).filter((item) => item.type === type);
      return items.length
        ? [
            {
              id: type,
              title,
              entries: items.map((item) => ({ key: `${item.serverId}:${item.ratingKey}`, item, badge: episodeLabel(item) })),
            },
          ]
        : [];
    });
  }, [results.data, t]);

  const status =
    term.length < MIN_LENGTH
      ? t('search.hint')
      : results.loading
        ? t('search.searching')
        : rows.length === 0
          ? t('search.none', { query: term })
          : '';

  return (
    <div className="search">
      <div className="search-keyboard">
        <div className="search-query">{query || <span className="muted">{t('search.placeholder')}</span>}</div>
        <div className="keyboard-grid">
          {KEYS.map((key, index) => (
            <FocusButton key={key} className="key" autoFocus={index === 0} onSelect={() => setQuery((value) => value + key)}>
              {key}
            </FocusButton>
          ))}
          <FocusButton className="key key-wide" onSelect={() => setQuery((value) => `${value} `)}>
            {t('search.space')}
          </FocusButton>
          <FocusButton className="key key-wide" onSelect={() => setQuery((value) => value.slice(0, -1))}>
            ⌫
          </FocusButton>
          <FocusButton className="key key-wide" onSelect={() => setQuery('')}>
            {t('search.clear')}
          </FocusButton>
        </div>
      </div>
      <div className="search-results">
        {status && <p className="muted search-status">{status}</p>}
        {rows.length > 0 && <Rows idPrefix="search" rows={rows} onSelect={nav.open} onContext={nav.menu} />}
      </div>
    </div>
  );
}
