import type { MessageKey } from '../../core/i18n';
import type { ServerEntry } from '../../core/serverRegistry';
import { useApp } from '../AppContext';
import { FocusButton } from '../focus/react';
import { useServers } from '../servers';

function statusText(entry: ServerEntry, t: ReturnType<typeof useApp>['t']): string {
  const { status } = entry;
  if (status.state === 'connecting') return t('servers.connecting');
  if (status.state === 'offline') return t('servers.offline');
  const key: MessageKey = status.connection.networkClass === 'local' ? 'servers.local' : 'servers.remote';
  return t(key, { latency: status.connection.latencyMs });
}

/** Connection status of every server, shown in Settings. */
export function ServerStatusList() {
  const { t } = useApp();
  const { entries, error, refresh } = useServers();
  return (
    <>
      <ul className="server-list">
        {entries?.length === 0 && <li className="muted">{t('servers.empty')}</li>}
        {entries?.map((entry) => (
          <li key={entry.server.clientIdentifier} className={`server-row ${entry.status.state}`}>
            <div>
              <div className="server-name">{entry.server.name}</div>
              <div className="muted">{t(entry.server.owned ? 'servers.owned' : 'servers.shared')}</div>
            </div>
            <div className="server-status">{statusText(entry, t)}</div>
          </li>
        ))}
        {!entries && !error && <li className="muted">{t('servers.connecting')}</li>}
        {error && <li className="error">{t('app.error', { message: error })}</li>}
      </ul>
      <FocusButton onSelect={refresh}>{t('servers.refresh')}</FocusButton>
    </>
  );
}
