import { type MutableRefObject, memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { LibrarySort } from '../../../shared/bridge';
import { posterOf, progressOf } from '../../core/home';
import { type LibrarySection, type MediaItem, fetchSectionPage, imageUrl, libraryId } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { Glyph } from '../components/Hints';
import { Poster } from '../components/Poster';
import type { FocusTarget } from '../focus/manager';
import { FocusButton, FocusScope, useFocusManager, useRegion } from '../focus/react';
import type { Action } from '../input';
import {
  GRID_COLS,
  GRID_POSTER_H,
  GRID_POSTER_W,
  GRID_ROW_H,
  GRID_STRIDE_X,
  focusedCardRect,
  gridMetrics,
  imageScale,
} from '../layout';
import { isWatched, useNav } from '../nav';
import { useServers } from '../servers';

const SORTS: LibrarySort[] = ['title', 'added', 'released', 'rating', 'watched'];
const PAGE_ROWS = 8;
const PAGE_SIZE = PAGE_ROWS * GRID_COLS;
/** Rows kept mounted above and below the visible ones. */
const OVERSCAN = 2;
/** Mirrors .grid-viewport padding: room for a focused card's scale-up. */
const BLEED = 12;
const PAGE_HINTS = { y: 'hint.sort' };

interface Cell {
  index: number;
  item?: MediaItem;
  src?: string;
}

const GridRow = memo(
  function GridRow({ row, padX, cells }: { row: number; padX: number; cells: Cell[] }) {
    return (
      <div className="grid-row" style={{ transform: `translate3d(0, ${BLEED + row * GRID_ROW_H}px, 0)`, paddingLeft: padX }}>
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
  },
  // Cells are rebuilt on every render; a row only changes when what it shows changes.
  (before, after) =>
    before.row === after.row &&
    before.padX === after.padX &&
    before.cells.length === after.cells.length &&
    before.cells.every((cell, i) => cell.item === after.cells[i].item && cell.src === after.cells[i].src),
);

interface GridProps {
  section: LibrarySection;
  sort: LibrarySort;
  onTotal: (total: number) => void;
  /** Set when the grid should take focus as soon as it has items (first open, new sort). */
  refocus: MutableRefObject<boolean>;
}

function LibraryGrid({ section, sort, onTotal, refocus }: GridProps) {
  const { plex, t } = useApp();
  const { byId, webdavTick } = useServers();
  const nav = useNav();
  const manager = useFocusManager();
  const server = byId(section.serverId);
  const [total, setTotal] = useState<number | null>(null);
  const [windowStart, setWindowStart] = useState(0);
  const [metrics, setMetrics] = useState(() => gridMetrics());
  const [, pageLoaded] = useReducer((n: number) => n + 1, 0);
  const pages = useRef(new Map<number, MediaItem[]>());
  const loading = useRef(new Set<number>());
  const viewport = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const focus = useRef(0);

  const { cols, padX, visibleRows } = metrics;
  const mountedRows = visibleRows + 2 * OVERSCAN;
  const totalRows = Math.ceil((total ?? 0) / cols);
  const itemAt = (index: number) => pages.current.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];

  useEffect(() => {
    const onResize = () => setMetrics(gridMetrics());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!section.isWebDav) return;
    pages.current.clear();
    loading.current.clear();
    pageLoaded();
  }, [section.isWebDav, webdavTick]);

  function ensurePage(page: number) {
    if (!server || pages.current.has(page) || loading.current.has(page)) return;
    if (total !== null && page * PAGE_SIZE >= total) return;
    loading.current.add(page);
    fetchSectionPage(plex, server, section, page * PAGE_SIZE, PAGE_SIZE, sort)
      .then(({ items, totalSize }) => {
        pages.current.set(page, items);
        setTotal(totalSize);
        onTotal(totalSize);
        pageLoaded();
      })
      .catch(() => {})
      .finally(() => loading.current.delete(page));
  }

  useEffect(() => {
    const first = Math.floor((windowStart * cols) / PAGE_SIZE);
    const last = Math.floor(((windowStart + mountedRows) * cols) / PAGE_SIZE);
    for (let page = first; page <= last + 1; page++) ensurePage(page);
  });

  /** `fromInput` is false inside React effects, where rows cannot be flushed synchronously. */
  function settle(fromInput = true): FocusTarget | null {
    if (!total || !viewport.current) return null;
    const index = Math.min(focus.current, total - 1);
    focus.current = index;
    const row = Math.floor(index / cols);
    const col = index % cols;
    const scrollRow = Math.max(0, Math.min(row - Math.max(0, visibleRows - 1), totalRows - visibleRows));
    content.current!.style.transform = `translate3d(0, ${-scrollRow * GRID_ROW_H}px, 0)`;
    const start = Math.max(0, scrollRow - OVERSCAN);
    if (start !== windowStart) {
      if (fromInput) flushSync(() => setWindowStart(start));
      else setWindowStart(start);
    }
    const element = document.getElementById(`grid-${index}`);
    if (!element) return null;
    const box = viewport.current.getBoundingClientRect();
    return {
      element,
      rect: focusedCardRect(
        box.left + padX + col * GRID_STRIDE_X,
        box.top + BLEED + (row - scrollRow) * GRID_ROW_H,
        GRID_POSTER_W,
        GRID_POSTER_H,
      ),
    };
  }

  const regionRef = useRegion<HTMLDivElement>({
    enter: () => settle(),
    move: (_focused, direction) => {
      const index = focus.current;
      const col = index % cols;
      let next = index;
      if (direction === 'left' && col > 0) next -= 1;
      if (direction === 'right' && col < cols - 1 && index + 1 < (total ?? 0)) next += 1;
      if (direction === 'up') next -= cols;
      if (direction === 'down' && index + cols < (total ?? 0)) next += cols;
      if (next < 0) return null;
      if (next === index) return direction === 'down' ? settle() : null;
      focus.current = next;
      return settle();
    },
    action: (_focused, action) => {
      if (action === 'page-up' || action === 'page-down') {
        const delta = visibleRows * cols * (action === 'page-up' ? -1 : 1);
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

  // The grid appears before its first items arrive; take focus once there is something to focus.
  useLayoutEffect(() => {
    if (!total) return;
    const focused = manager.focused;
    if (refocus.current || !focused || !focused.isConnected || viewport.current?.contains(focused)) {
      refocus.current = false;
      manager.focus(settle(false));
    }
  }, [total]);

  const rows = [];
  for (let row = windowStart; row < Math.min(totalRows, windowStart + mountedRows); row++) {
    const cells: Cell[] = [];
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      if (index >= (total ?? 0)) break;
      const item = itemAt(index);
      const path = item ? posterOf(item) : undefined;
      cells.push({
        index,
        item,
        src: server && path ? imageUrl(server, path, GRID_POSTER_W, GRID_POSTER_H, imageScale()) : undefined,
      });
    }
    rows.push(<GridRow key={row} row={row} padX={padX} cells={cells} />);
  }

  return (
    <>
      {total === 0 && <p className="page-message muted">{t('libraries.emptyLibrary')}</p>}
      <div
        className="grid-viewport"
        data-autofocus=""
        data-hint-a="hint.open"
        data-hint-x="hint.options"
        data-hint-lt-rt="hint.page"
        ref={viewportRef}
      >
        <div className="grid-content" ref={content}>
          {rows}
        </div>
      </div>
    </>
  );
}

function SortMenu({ sort, onChoose, onClose }: { sort: LibrarySort; onChoose: (sort: LibrarySort) => void; onClose: () => void }) {
  const { t } = useApp();
  return (
    <FocusScope className="overlay" onBack={onClose} hints={{ b: 'hint.close' }}>
      <div className="menu-panel">
        <h2>{t('library.sortBy')}</h2>
        {SORTS.map((option) => (
          <FocusButton
            key={option}
            className={option === sort ? 'menu-option selected' : 'menu-option'}
            autoFocus={option === sort}
            onSelect={() => onChoose(option)}
          >
            {t(`sort.${option}`)}
            {option === sort && <span>✓</span>}
          </FocusButton>
        ))}
      </div>
    </FocusScope>
  );
}

export function LibraryPage({ section }: { section: LibrarySection }) {
  const { settings, updateSettings, t } = useApp();
  const { byId } = useServers();
  const nav = useNav();
  const server = byId(section.serverId);
  const id = libraryId(section);
  const sort = settings.librarySort[id] ?? 'title';
  const [total, setTotal] = useState<number | null>(null);
  const [sorting, setSorting] = useState(false);
  const refocus = useRef(true);

  const onAction = useCallback((action: Action) => {
    if (action !== 'search') return false;
    setSorting(true);
    return true;
  }, []);

  const choose = (next: LibrarySort) => {
    setSorting(false);
    if (next === sort) return;
    refocus.current = true;
    void updateSettings({ librarySort: { ...settings.librarySort, [id]: next } });
  };

  return (
    <FocusScope className="page library-page" onBack={nav.pop} onAction={onAction} hints={PAGE_HINTS}>
      <header className="page-header">
        <h1>{section.title}</h1>
        {section.isWebDav && <span className="webdav-badge">WebDAV</span>}
        <span className="muted">
          {!section.isWebDav && server?.name}
          {total !== null && `${!section.isWebDav && server?.name ? ' · ' : ''}${t('library.count', { count: total })}`}
        </span>
        <FocusButton className="sort-button" onSelect={() => setSorting(true)}>
          <Glyph button="y" />
          {t(`sort.${sort}`)}
        </FocusButton>
      </header>
      <LibraryGrid key={sort} section={section} sort={sort} onTotal={setTotal} refocus={refocus} />
      {sorting && <SortMenu sort={sort} onChoose={choose} onClose={() => setSorting(false)} />}
    </FocusScope>
  );
}
