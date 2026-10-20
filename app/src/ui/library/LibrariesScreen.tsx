import { type LibrarySection, fetchSections } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { FocusButton } from '../focus/react';
import { useNav } from '../nav';
import { useResource } from '../resource';
import { useServers } from '../servers';

/** Movie and TV libraries of every connected server. */
export function useSections() {
  const { plex } = useApp();
  const { online } = useServers();
  const key = online.map((server) => server.id).sort().join(',');
  return useResource(key ? `sections:${key}` : null, async () =>
    (await Promise.all(online.map((server) => fetchSections(plex, server).catch(() => [] as LibrarySection[])))).flat(),
  );
}

export function LibrariesScreen() {
  const { t } = useApp();
  const { online } = useServers();
  const nav = useNav();
  const sections = useSections();

  const groups = online
    .map((server) => ({ server, sections: (sections.data ?? []).filter((section) => section.serverId === server.id) }))
    .filter((group) => group.sections.length > 0);

  return (
    <div className="libraries" data-scroll="y">
      <div className="scroll-content">
        {groups.length === 0 && <p className="muted">{sections.loading || online.length === 0 ? t('app.loading') : t('libraries.empty')}</p>}
        {groups.map(({ server, sections: list }, groupIndex) => (
          <section key={server.id} className="library-group">
            <h2>{server.name}</h2>
            <div className="library-tiles">
              {list.map((section, index) => (
                <FocusButton
                  key={section.key}
                  className="library-tile"
                  autoFocus={groupIndex === 0 && index === 0}
                  data-hint-a="hint.open"
                  onSelect={() => nav.push({ kind: 'library', section })}
                >
                  <span className="library-name">{section.title}</span>
                  <span className="muted">{t(section.type === 'movie' ? 'libraries.movies' : 'libraries.shows')}</span>
                </FocusButton>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
