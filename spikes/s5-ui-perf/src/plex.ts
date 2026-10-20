export interface Item {
  id: string;
  title: string;
  year?: number;
  thumb: string;
  art?: string;
}

interface PlexMetadata {
  ratingKey: string;
  title: string;
  year?: number;
  thumb?: string;
  art?: string;
}

async function getJson<T>(config: PlayDeckConfig, path: string): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': config.token,
      'X-Plex-Product': 'PlayDeck',
      'X-Plex-Client-Identifier': 'playdeck-spike-s5',
    },
  });
  if (!response.ok) throw new Error(`Plex ${path}: HTTP ${response.status}`);
  return (await response.json()).MediaContainer as T;
}

export async function loadItems(config: PlayDeckConfig): Promise<Item[]> {
  const { Directory: sections = [] } = await getJson<{ Directory?: { key: string; type: string }[] }>(
    config,
    '/library/sections',
  );
  const libraries = await Promise.all(
    sections
      .filter((section) => section.type === 'movie' || section.type === 'show')
      .map((section) => getJson<{ Metadata?: PlexMetadata[] }>(config, `/library/sections/${section.key}/all`)),
  );
  return libraries
    .flatMap((library) => library.Metadata ?? [])
    .filter((item) => item.thumb)
    .map((item) => ({ id: item.ratingKey, title: item.title, year: item.year, thumb: item.thumb!, art: item.art }));
}

/** Server-side resized image. `variant` defeats the HTTP cache so repeated grid items exercise real loads. */
export function photoUrl(config: PlayDeckConfig, path: string, width: number, height: number, variant = 0): string {
  const scale = window.devicePixelRatio || 1;
  const params = new URLSearchParams({
    width: String(Math.round(width * scale)),
    height: String(Math.round(height * scale)),
    minSize: '1',
    upscale: '1',
    url: path,
    'X-Plex-Token': config.token,
  });
  if (variant) params.set('_v', String(variant));
  return `${config.baseUrl}/photo/:/transcode?${params}`;
}
