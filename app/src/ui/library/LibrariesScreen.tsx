import { type LibrarySection, fetchSections } from '../../core/plex/library';
import { getWebDavCatalog } from '../../core/webdav/scanner';
import { useApp } from '../AppContext';
import { FocusButton } from '../focus/react';
import { useNav } from '../nav';
import { useResource } from '../resource';
import { useServers } from '../servers';

/** Movie, TV and Mixed libraries of every connected server (Plex and WebDAV). */
export function useSections() {
  const { plex } = useApp();
  const { online, webdavTick } = useServers();
  const key = online.map((server) => server.id).sort().join(',');
  return useResource(key ? `sections:${key}:${webdavTick}` : null, async () =>
    (await Promise.all(online.map((server) => fetchSections(plex, server).catch(() => [] as LibrarySection[])))).flat(),
  );
}

export function LibrariesScreen() {
  const { t } = useApp();
  const { online } = useServers();
  const nav = useNav();
  const sections = useSections();

  const plexServers = online.filter((server) => server.kind !== 'webdav');
  const webdavServers = online.filter((server) => server.kind === 'webdav');

  const plexGroups = plexServers
    .map((server) => ({ server, sections: (sections.data ?? []).filter((section) => section.serverId === server.id) }))
    .filter((group) => group.sections.length > 0);

  const webdavSections = webdavServers.flatMap((server) =>
    (sections.data ?? []).filter((section) => section.serverId === server.id),
  );

  const isEmpty = plexGroups.length === 0 && webdavSections.length === 0;

  return (
    <div className="libraries" data-scroll="y">
      <div className="scroll-content">
        {isEmpty && (
          <p className="muted">{sections.loading || online.length === 0 ? t('app.loading') : t('libraries.empty')}</p>
        )}
        {plexGroups.map(({ server, sections: list }, groupIndex) => (
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
                  <span className="muted">
                    {t(
                      section.type === 'movie'
                        ? 'libraries.movies'
                        : section.type === 'show'
                          ? 'libraries.shows'
                          : 'libraries.mixed',
                    )}
                  </span>
                </FocusButton>
              ))}
            </div>
          </section>
        ))}
        {webdavSections.length > 0 && (
          <section className="library-group">
            <h2>WebDAV</h2>
            <div className="library-tiles">
              {webdavSections.map((section, index) => {
                const catalog = getWebDavCatalog(section.serverId);
                const typeLabel = t(
                  section.type === 'movie'
                    ? 'libraries.movies'
                    : section.type === 'show'
                      ? 'libraries.shows'
                      : 'libraries.mixed',
                );
                const statusLabel = catalog?.scanning
                  ? `${typeLabel} · ${t('webdav.scanningFolders', {
                      scanned: catalog.scannedFolders,
                      total: Math.max(catalog.totalFolders, catalog.scannedFolders),
                    })}`
                  : catalog
                    ? `${typeLabel} · ${t('library.count', { count: catalog.topItems.length })}`
                    : typeLabel;
                return (
                  <FocusButton
                    key={`${section.serverId}:${section.key}`}
                    className="library-tile webdav-library-tile"
                    autoFocus={plexGroups.length === 0 && index === 0}
                    data-hint-a="hint.open"
                    onSelect={() => nav.push({ kind: 'library', section })}
                  >
                    <div className="library-tile-head">
                      <span className="library-name">{section.title}</span>
                      <span className="webdav-badge">WebDAV</span>
                    </div>
                    <span className="muted">{statusLabel}</span>
                  </FocusButton>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
