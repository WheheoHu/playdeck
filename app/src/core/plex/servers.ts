import type { PlexConnection, PlexServer } from '../../../shared/bridge';
import { type PlexContext, requestAccountApi } from './client';

export type { PlexConnection, PlexServer };

interface ResourceResponse {
  name?: string;
  clientIdentifier?: string;
  accessToken?: string;
  provides?: string;
  owned?: boolean | number;
  productVersion?: string;
  connections?: {
    uri?: string;
    protocol?: string;
    address?: string;
    port?: number;
    local?: boolean | number;
    relay?: boolean | number;
    IPv6?: boolean | number;
  }[];
}

export function parseServers(resources: ResourceResponse[]): PlexServer[] {
  const servers: PlexServer[] = [];
  for (const resource of resources) {
    if (!resource.provides?.split(',').includes('server')) continue;
    if (!resource.name || !resource.clientIdentifier || !resource.accessToken) continue;
    const connections = (resource.connections ?? []).flatMap((connection): PlexConnection[] =>
      connection.uri && connection.address && connection.port
        ? [
            {
              uri: connection.uri.replace(/\/$/, ''),
              protocol: connection.protocol === 'http' ? 'http' : 'https',
              address: connection.address,
              port: connection.port,
              local: Boolean(connection.local),
              relay: Boolean(connection.relay),
              ipv6: Boolean(connection.IPv6),
            },
          ]
        : [],
    );
    servers.push({
      name: resource.name,
      clientIdentifier: resource.clientIdentifier,
      accessToken: resource.accessToken,
      owned: Boolean(resource.owned),
      productVersion: resource.productVersion,
      connections,
    });
  }
  return servers;
}

/** Servers the user can reach, each with the access token valid for that user on that server. */
export async function fetchServers(context: PlexContext, userToken: string, signal?: AbortSignal): Promise<PlexServer[]> {
  const resources = await requestAccountApi<ResourceResponse[]>(
    context,
    '/resources?includeHttps=1&includeRelay=1&includeIPv6=1',
    { token: userToken, signal },
  );
  return parseServers(resources);
}
