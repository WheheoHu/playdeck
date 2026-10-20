import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { posterOf, progressOf } from '../../core/home';
import { type LibrarySection, type MediaItem, fetchSectionPage, imageUrl } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { Poster } from '../components/Poster';
import type { FocusTarget } from '../focus/manager';
import { FocusScope, useFocusManager, useRegion } from '../focus/react';
import { GRID_COLS, GRID_ROW_H, POSTER_H, POSTER_W, PAD_X, STRIDE_X, focusedCardRect, imageScale } from '../layout';
import { isWatched, useNav } from '../nav';
import { useServers } from '../servers';

const PAGE_ROWS = 9;
const PAGE_SIZE = PAGE_ROWS * GRID_COLS;
/** Rows kept mounted above and below the visible ones. */
const OVERSCAN = 2;
const VISIBLE_ROWS = 3;
const MOUNTED_ROWS = VISIBLE_ROWS + 2 * OVERSCAN;
/** Mirrors .grid-viewport padding: room for a focused card's scale-up. */
const BLEED = 12;

interface Cell {
  index: number;
  item?: MediaItem;
  src?: string;
}

const GridRow = memo(function GridRow({ row, cells }: { row: number; cells: Cell[] }) {
  return (
    <div className="grid-row" style={{ transform: `translate3d(0, ${BLEED + row * GRID_ROW_H}px, 0)` }}>
      {cells.map(({ index, item, src }) => (
        <div className="grid-cell" key={index}>
          <Poster
            id={`grid-${index}`}
            src={src}
            title={item?.title ?? ''}
            progress={item ? progressOf(item) : null}
            watched={item ? isWatched(item) : false}
          />
          <div className="grid-caption">
            <span className="grid-title">{item?.title ?? ''}</span>
            <span className="muted">{item?.year ?? ''}</span>
          </div>
        </div>
      ))}
    </div>
  );
});

export function LibraryPage({ section }: { section: LibrarySection }) {
  const { plex, t } = useApp();
  const { byId } = useServers();
  const nav = useNav();
  const manager = useFocusManager();
  const server = byId(section.serverId);
  const [total, setTotal] = useState<number | null>(null);
  const [windowStart, setWindowStart] = useState(0);
  const [, pageLoaded] = useReducer((n: number) => n + 1, 0);
  const pages = useRef(new Map<number, MediaItem[]>());
  const loading = useRef(new Set<number>());
  const viewport = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const focus = useRef(0);

  const totalRows = Math.ceil((total ?? 0) / GRID_COLS);
  const itemAt = (index: number) => pages.current.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];

  function ensurePage(page: number) {
    if (!server || pages.current.has(page) || loading.current.has(page)) return;
    if (total !== null && page * PAGE_SIZE >= total) return;
    loading.current.add(page);
    fetchSectionPage(plex, server, section, page * PAGE_SIZE, PAGE_SIZE)
      .then(({ items, totalSize }) => {
        pages.current.set(page, items);
        setTotal(totalSize);
        pageLoaded();
      })
      .catch(() => {})
      .finally(() => loading.current.delete(page));
  }

  useEffect(() => {
    const first = Math.floor((windowStart * GRID_COLS) / PAGE_SIZE);
    const last = Math.floor(((windowStart + MOUNTED_ROWS) * GRID_COLS) / PAGE_SIZE);
    for (let page = first; page <= last + 1; page++) ensurePage(page);
  });

  /** `fromInput` is false inside React effects, where rows cannot be flushed synchronously. */
  function settle(fromInput = true): FocusTarget | null {
    if (!total || !viewport.current) return null;
    const index = Math.min(focus.current, total - 1);
    focus.current = index;
    const row = Math.floor(index / GRID_COLS);
    const col = index % GRID_COLS;
    const scrollRow = Math.max(0, Math.min(row - 1, totalRows - VISIBLE_ROWS + 1));
    content.current!.style.transform = `translate3d(0, ${-scrollRow * GRID_ROW_H}px, 0)`;
    const start = Math.max(0, scrollRow - OVERSCAN);
    if (start !== windowStart) {
      if (fromInput) flushSync(() => setWindowStart(start));
      else setWindowStart(start);
    }
    const element = document.getElementById(`grid-${index}`);
    if (!element) return null;
    const box = viewport.current.getBoundingClientRect();
    return { element, rect: focusedCardRect(box.left + PAD_X + col * STRIDE_X, box.top + BLEED + (row - scrollRow) * GRID_ROW_H) };
  }

  const regionRef = useRegion<HTMLDivElement>({
    enter: () => settle(),
    move: (_focused, direction) => {
      const index = focus.current;
      const col = index % GRID_COLS;
      let next = index;
      if (direction === 'left' && col > 0) next -= 1;
      if (direction === 'right' && col < GRID_COLS - 1 && index + 1 < (total ?? 0)) next += 1;
      if (direction === 'up') next -= GRID_COLS;
      if (direction === 'down' && index + GRID_COLS < (total ?? 0)) next += GRID_COLS;
      if (next < 0) return null;
      if (next === index) return direction === 'down' ? settle() : null;
      focus.current = next;
      return settle();
    },
    action: (_focused, action) => {
      if (action === 'page-up' || action === 'page-down') {
        const delta = VISIBLE_ROWS * GRID_COLS * (action === 'page-up' ? -1 : 1);
        focus.current = Math.max(0, Math.min((total ?? 1) - 1, focus.current + delta));
        manager.focus(settle());
        return true;
      }
      const item = itemAt(focus.current);
      if (!item) return false;
      if (action === 'select') nav.open(item);
      else if (action === 'context') nav.menu(item);
      else return false;
      return true;
    },
  });

  const viewportRef = useCallback(
    (element: HTMLDivElement | null) => {
      viewport.current = element;
      regionRef(element);
    },
    [regionRef],
  );

  // The page opens before its first items arrive; take focus once there is something to focus.
  useLayoutEffect(() => {
    if (!total) return;
    const focused = manager.focused;
    if (!focused || !focused.isConnected || viewport.current?.contains(focused)) manager.focus(settle(false));
  }, [total]);

  const rows = [];
  for (let row = windowStart; row < Math.min(totalRows, windowStart + MOUNTED_ROWS); row++) {
    const cells: Cell[] = [];
    for (let col = 0; col < GRID_COLS; col++) {
      const index = row * GRID_COLS + col;
      if (index >= (total ?? 0)) break;
      const item = itemAt(index);
      const path = item ? posterOf(item) : undefined;
      cells.push({ index, item, src: server && path ? imageUrl(server, path, POSTER_W, POSTER_H, imageScale()) : undefined });
    }
    rows.push(<GridRow key={row} row={row} cells={cells} />);
  }

  return (
    <FocusScope className="page library-page" onBack={nav.pop}>
      <header className="page-header">
        <h1>{section.title}</h1>
        <span className="muted">
          {server?.name}
          {total !== null && ` · ${t('library.count', { count: total })}`}
        </span>
      </header>
      {total === 0 && <p className="muted">{t('libraries.emptyLibrary')}</p>}
      <div className="grid-viewport" ref={viewportRef}>
        <div className="grid-content" ref={content}>
          {rows}
        </div>
      </div>
    </FocusScope>
  );
}
