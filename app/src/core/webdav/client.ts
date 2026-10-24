import type { WebDavLibraryConfig, WebDavRequest, WebDavResponse } from '../../../shared/bridge';

export interface WebDavConnection {
  baseUrl: string;
  username?: string;
  password?: string;
}

export interface WebDavEntry {
  /** Decoded absolute path on the server starting with "/", e.g. "/dav/Movies/Inception (2010)". */
  path: string;
  /** Entry basename without trailing slash. */
  name: string;
  isDirectory: boolean;
  size?: number;
  /** Unix timestamp in seconds. */
  lastModified?: number;
}

export type WebDavTransport = (request: WebDavRequest) => Promise<WebDavResponse>;

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`;

export class WebDavHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`WebDAV request failed: HTTP ${status} for ${url}`);
  }
}

/** Splits a user-entered WebDAV URL into `{ baseUrl, rootPath }`. */
export function normalizeWebDavUrl(raw: string): { baseUrl: string; rootPath: string } {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  const baseUrl = parsed.origin;
  const decodedPath = decodeURIComponent(parsed.pathname || '/');
  const rootPath = normalizePath(decodedPath);
  return { baseUrl, rootPath };
}

/** Ensures a path starts with "/" and has no trailing slash (except "/" itself). */
export function normalizePath(path: string): string {
  const cleaned = (`/${path}`).replace(/\/+/g, '/');
  return cleaned.length > 1 ? cleaned.replace(/\/$/, '') : '/';
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '/' : normalized.slice(0, idx);
}

export function joinPath(parent: string, child: string): string {
  return normalizePath(`${parent}/${child}`);
}

/** Encodes each segment of a decoded WebDAV path into a full request URL. */
export function buildWebDavUrl(baseUrl: string, path: string, isDirectory = false): string {
  const normalized = normalizePath(path);
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const suffix = isDirectory && encoded !== '/' ? '/' : '';
  return `${baseUrl.replace(/\/$/, '')}${encoded}${suffix}`;
}

/** Builds a `playdeck://app/__webdav__` URL so `<img>` elements load authenticated WebDAV artwork. */
export function webdavImageProxyUrl(libId: string, baseUrl: string, path: string): string {
  const targetUrl = buildWebDavUrl(baseUrl, path);
  const params = new URLSearchParams({ lib: libId, url: targetUrl });
  return `playdeck://app/__webdav__?${params}`;
}

export function basicAuthHeader(username?: string, password?: string): string | undefined {
  if (!username && !password) return undefined;
  const bytes = new TextEncoder().encode(`${username ?? ''}:${password ?? ''}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export function webdavHeaders(connection: WebDavConnection, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const auth = basicAuthHeader(connection.username, connection.password);
  if (auth) headers.Authorization = auth;
  return headers;
}

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function extractTag(block: string, localName: string): string | undefined {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${localName}>`, 'i');
  const match = block.match(pattern);
  return match ? decodeXmlEntities(match[1].trim()) : undefined;
}

function hasCollectionTag(block: string): boolean {
  const resourceType = extractTag(block, 'resourcetype');
  if (!resourceType) return false;
  return /<(?:[\w-]+:)?collection\b/i.test(resourceType);
}

function safeDecodeUri(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Parses a WebDAV `207 Multi-Status` XML payload into directory and file entries, excluding the
 * requested directory itself and hidden dotfiles.
 */
export function parsePropfindXml(xml: string, requestedPath: string): WebDavEntry[] {
  const normalizedTarget = normalizePath(requestedPath);
  const responseRegex = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  const entries: WebDavEntry[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(responseRegex)) {
    const block = match[1];
    const status = extractTag(block, 'status');
    if (status && !/\b2\d\d\b/.test(status)) continue;

    const rawHref = extractTag(block, 'href');
    if (!rawHref) continue;

    let hrefPath = rawHref;
    if (/^https?:\/\//i.test(rawHref)) {
      try {
        hrefPath = new URL(rawHref).pathname;
      } catch {
        // Keep rawHref if URL parsing fails.
      }
    }
    const decodedHref = safeDecodeUri(hrefPath);
    const isDir = hasCollectionTag(block) || (decodedHref.length > 1 && decodedHref.endsWith('/'));
    const entryPath = normalizePath(decodedHref);

    // Skip the queried folder itself.
    if (entryPath === normalizedTarget) continue;
    // Only include direct children of requestedPath (in case a server ignores Depth: 1).
    if (parentPath(entryPath) !== normalizedTarget) continue;
    if (seen.has(entryPath)) continue;
    seen.add(entryPath);

    const basename = entryPath.slice(entryPath.lastIndexOf('/') + 1);
    if (!basename || basename.startsWith('.')) continue;

    const lengthStr = extractTag(block, 'getcontentlength');
    const size = lengthStr !== undefined ? Number(lengthStr) : undefined;
    const modifiedStr = extractTag(block, 'getlastmodified');
    const modifiedMs = modifiedStr ? Date.parse(modifiedStr) : Number.NaN;

    entries.push({
      path: entryPath,
      name: basename,
      isDirectory: isDir,
      size: size !== undefined && Number.isFinite(size) && size >= 0 ? size : undefined,
      lastModified: Number.isFinite(modifiedMs) ? Math.floor(modifiedMs / 1000) : undefined,
    });
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

export async function propfind(
  transport: WebDavTransport,
  connection: WebDavConnection,
  dirPath: string,
  timeoutMs = 15_000,
): Promise<WebDavEntry[]> {
  const url = buildWebDavUrl(connection.baseUrl, dirPath, true);
  const response = await transport({
    url,
    method: 'PROPFIND',
    headers: webdavHeaders(connection, {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    }),
    body: PROPFIND_BODY,
    timeoutMs,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new WebDavHttpError(response.status, url);
  }
  return parsePropfindXml(response.body, dirPath);
}

export async function fetchWebDavText(
  transport: WebDavTransport,
  connection: WebDavConnection,
  filePath: string,
  timeoutMs = 10_000,
): Promise<string> {
  const url = buildWebDavUrl(connection.baseUrl, filePath, false);
  const response = await transport({
    url,
    method: 'GET',
    headers: webdavHeaders(connection),
    timeoutMs,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new WebDavHttpError(response.status, url);
  }
  return response.body;
}

export function connectionOf(config: WebDavLibraryConfig): WebDavConnection {
  return {
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
  };
}
