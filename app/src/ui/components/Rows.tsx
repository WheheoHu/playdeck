import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { posterOf, progressOf } from '../../core/home';
import { type MediaItem, imageUrl } from '../../core/plex/library';
import type { FocusTarget } from '../focus/manager';
import { useFocusManager, useRegion } from '../focus/react';
import { POSTER_H, POSTER_W, PAD_X, ROW_H, ROW_LABEL_H, ROW_LEAD, STRIDE_X, focusedCardRect, imageScale } from '../layout';
import { useServers } from '../servers';
import { Poster } from './Poster';

export interface RowEntry {
  key: string;
  item: MediaItem;
  badge?: string;
}

export interface Row {
  id: string;
  title: string;
  entries: RowEntry[];
}

interface RowsProps {
  idPrefix: string;
  rows: Row[];
  onSelect: (item: MediaItem) => void;
  onContext?: (item: MediaItem) => void;
  onFocusItem?: (item: MediaItem) => void;
  autoFocus?: boolean;
}

/** Room above the rows for a focused card's scale-up; mirrors .rows-viewport padding. */
const BLEED = 12;

/**
 * Horizontal rows of posters as one focus region. The focused row always sits at the top of the
 * viewport and scrolls horizontally once focus passes ROW_LEAD cards; each row remembers its column.
 */
export const Rows = memo(function Rows({ idPrefix, rows, onSelect, onContext, onFocusItem, autoFocus }: RowsProps) {
  const { byId } = useServers();
  const manager = useFocusManager();
  const viewport = useRef<HTMLDivElement | null>(null);
  const rowsElement = useRef<HTMLDivElement>(null);
  const tracks = useRef<(HTMLDivElement | null)[]>([]);
  const state = useRef({ row: 0, cols: [] as number[] });
  const cardId = (row: number, col: number) => `${idPrefix}-${row}-${col}`;

  function settle(): FocusTarget | null {
    const s = state.current;
    if (rows.length === 0) return null;
    s.row = Math.min(s.row, rows.length - 1);
    const entries = rows[s.row].entries;
    const col = Math.min(s.cols[s.row] ?? 0, entries.length - 1);
    s.cols[s.row] = col;
    const element = document.getElementById(cardId(s.row, col));
    if (!element || !viewport.current) return null;

    const scroll = Math.max(0, col - ROW_LEAD);
    rowsElement.current!.style.transform = `translate3d(0, ${-s.row * ROW_H}px, 0)`;
    const track = tracks.current[s.row];
    if (track) track.style.transform = `translate3d(${-scroll * STRIDE_X}px, 0, 0)`;
    onFocusItem?.(entries[col].item);

    const box = viewport.current.getBoundingClientRect();
    return { element, rect: focusedCardRect(box.left + PAD_X + (col - scroll) * STRIDE_X, box.top + BLEED + ROW_LABEL_H) };
  }

  const regionRef = useRegion<HTMLDivElement>({
    enter: () => settle(),
    move: (_focused, direction) => {
      const s = state.current;
      if (direction === 'up' || direction === 'down') {
        const next = s.row + (direction === 'up' ? -1 : 1);
        if (next < 0 || next >= rows.length) return null;
        s.row = next;
      } else {
        const col = (s.cols[s.row] ?? 0) + (direction === 'left' ? -1 : 1);
        if (col < 0 || col >= rows[s.row].entries.length) return null;
        s.cols[s.row] = col;
      }
      return settle();
    },
    action: (_focused, action) => {
      const s = state.current;
      const entry = rows[s.row]?.entries[s.cols[s.row] ?? 0];
      if (!entry) return false;
      if (action === 'select') onSelect(entry.item);
      else if (action === 'context' && onContext) onContext(entry.item);
      else return false;
      return true;
    },
  });

  useLayoutEffect(() => {
    const focused = manager.focused;
    if (focused && viewport.current?.contains(focused)) manager.focus(settle());
  });

  const viewportRef = useCallback(
    (element: HTMLDivElement | null) => {
      viewport.current = element;
      regionRef(element);
    },
    [regionRef],
  );

  return (
    <div className="rows-viewport" data-autofocus={autoFocus ? '' : undefined} ref={viewportRef}>
      <div className="rows" ref={rowsElement}>
        {rows.map((row, r) => (
          <section className="row" key={row.id}>
            <div className="row-label">{row.title}</div>
            <div className="track" ref={(element) => void (tracks.current[r] = element)}>
              {row.entries.map((entry, c) => {
                const server = byId(entry.item.serverId);
                const path = posterOf(entry.item);
                return (
                  <Poster
                    key={entry.key}
                    id={cardId(r, c)}
                    src={server && path ? imageUrl(server, path, POSTER_W, POSTER_H, imageScale()) : undefined}
                    title={entry.item.grandparentTitle ?? entry.item.title}
                    progress={progressOf(entry.item)}
                    watched={entry.item.type === 'movie' && Boolean(entry.item.viewCount) && !entry.item.viewOffset}
                    badge={entry.badge}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
});
