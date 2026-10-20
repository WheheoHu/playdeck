import { useEffect, useMemo, useRef, useState } from 'react';
import { budgetFor, FrameRecorder } from './frameStats';
import { type HomeRow, Home } from './Home';
import { listenForActions } from './input';
import { HOME_ROWS, HOME_ROW_ITEMS } from './layout';
import { LibraryGrid } from './LibraryGrid';
import type { PageHandle } from './page';
import { type Item, loadItems } from './plex';

type Page = 'home' | 'library';

const ROW_TITLES = ['Continue Watching', 'Recently Added', 'Movies', 'TV Shows', 'Anime', 'Because You Watched'];

function buildRows(pool: Item[]): HomeRow[] {
  return ROW_TITLES.slice(0, HOME_ROWS).map((title, r) => ({
    title,
    items: Array.from({ length: HOME_ROW_ITEMS }, (_, i) => pool[(r * 17 + i) % pool.length]),
  }));
}

export function App() {
  const [data, setData] = useState<{ config: PlayDeckConfig; pool: Item[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('home');
  const pageRef = useRef<Page>(page);
  const homeRef = useRef<PageHandle>(null);
  const gridRef = useRef<PageHandle>(null);
  pageRef.current = page;

  useEffect(() => {
    (async () => {
      const config = await window.playdeck.getConfig();
      setData({ config, pool: await loadItems(config) });
    })().catch((e: Error) => setError(e.message));
  }, []);

  const rows = useMemo(() => (data ? buildRows(data.pool) : []), [data]);

  useEffect(() => {
    if (!data) return;
    const dispose = listenForActions((action) => {
      if (action === 'next-page') setPage('library');
      else if (action === 'previous-page') setPage('home');
      else (pageRef.current === 'home' ? homeRef : gridRef).current?.move(action);
    });

    let recorder: FrameRecorder | null = null;
    window.playdeck.onHarness((message) => {
      if (message.type === 'start') (recorder = new FrameRecorder()).start();
      if (message.type === 'phase') recorder?.mark(message.phase);
      if (message.type === 'stop' && recorder) {
        window.playdeck.reportResult(recorder.stop(budgetFor(data.config.refreshHz ?? 60)));
      }
    });
    const readyTimer = window.setTimeout(() => window.playdeck.ready(), 1500);
    return () => {
      dispose();
      window.clearTimeout(readyTimer);
    };
  }, [data]);

  if (error) return <div className="message">Failed to load Plex data: {error}</div>;
  if (!data) return <div className="message">Loading…</div>;

  return (
    <>
      <div className={page === 'home' ? 'page' : 'page hidden'}>
        <Home ref={homeRef} config={data.config} rows={rows} />
      </div>
      <div className={page === 'library' ? 'page' : 'page hidden'}>
        <LibraryGrid ref={gridRef} config={data.config} pool={data.pool} />
      </div>
    </>
  );
}
