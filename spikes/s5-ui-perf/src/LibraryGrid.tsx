import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  CARD_H,
  CARD_W,
  FOCUS_BLEED,
  GRID_COLS,
  GRID_ITEMS,
  GRID_OVERSCAN,
  GRID_ROW_H,
  GRID_TOP,
  GRID_VISIBLE_ROWS,
  PAD_X,
  STRIDE_X,
} from './layout';
import { type Direction, type PageHandle, moveFocusClass, setTransform } from './page';
import { type Item, photoUrl } from './plex';
import { Poster } from './Poster';

interface LibraryGridProps {
  config: PlayDeckConfig;
  pool: Item[];
}

const TOTAL_ROWS = Math.ceil(GRID_ITEMS / GRID_COLS);
const MOUNTED_ROWS = GRID_VISIBLE_ROWS + 2 * GRID_OVERSCAN;
const cardId = (index: number) => `g-${index}`;
const scrollRowFor = (row: number) => Math.max(0, Math.min(row - 1, TOTAL_ROWS - GRID_VISIBLE_ROWS));

const GridRow = memo(function GridRow({ row, config, pool }: { row: number } & LibraryGridProps) {
  const cells = [];
  for (let col = 0; col < GRID_COLS; col++) {
    const index = row * GRID_COLS + col;
    if (index >= GRID_ITEMS) break;
    const item = pool[index % pool.length];
    const variant = Math.floor(index / pool.length);
    cells.push(<Poster key={index} id={cardId(index)} src={photoUrl(config, item.thumb, CARD_W, CARD_H, variant)} />);
  }
  return (
    <div className="grid-row" style={{ transform: `translate3d(0, ${FOCUS_BLEED + row * GRID_ROW_H}px, 0)` }}>
      {cells}
    </div>
  );
});

export const LibraryGrid = memo(
  forwardRef<PageHandle, LibraryGridProps>(function LibraryGrid({ config, pool }, ref) {
    const [windowStart, setWindowStart] = useState(0);
    const contentRef = useRef<HTMLDivElement>(null);
    const ringRef = useRef<HTMLDivElement>(null);
    const state = useRef({ index: 0, focusedId: null as string | null, pendingId: null as string | null });

    function apply() {
      const s = state.current;
      const row = Math.floor(s.index / GRID_COLS);
      const col = s.index % GRID_COLS;
      const scrollRow = scrollRowFor(row);
      setTransform(contentRef.current, 0, -scrollRow * GRID_ROW_H);
      setTransform(ringRef.current, PAD_X + col * STRIDE_X, GRID_TOP + (row - scrollRow) * GRID_ROW_H);
      setWindowStart(Math.max(0, scrollRow - GRID_OVERSCAN));
      const id = cardId(s.index);
      s.pendingId = moveFocusClass(s.focusedId, id) ? null : id;
      s.focusedId = id;
    }

    useLayoutEffect(() => {
      const s = state.current;
      if (s.pendingId && moveFocusClass(null, s.pendingId)) s.pendingId = null;
    });

    useLayoutEffect(apply, []);

    useImperativeHandle(ref, () => ({
      move(direction: Direction) {
        const s = state.current;
        const before = s.index;
        const col = s.index % GRID_COLS;
        if (direction === 'left' && col > 0) s.index -= 1;
        if (direction === 'right' && col < GRID_COLS - 1 && s.index + 1 < GRID_ITEMS) s.index += 1;
        if (direction === 'up' && s.index - GRID_COLS >= 0) s.index -= GRID_COLS;
        if (direction === 'down' && s.index + GRID_COLS < GRID_ITEMS) s.index += GRID_COLS;
        if (s.index !== before) apply();
      },
    }));

    const rows = [];
    for (let row = windowStart; row < Math.min(TOTAL_ROWS, windowStart + MOUNTED_ROWS); row++) {
      rows.push(<GridRow key={row} row={row} config={config} pool={pool} />);
    }

    return (
      <>
        <div className="grid-header">Library · {GRID_ITEMS.toLocaleString()} items</div>
        <div className="grid-viewport">
          <div className="grid-content" ref={contentRef}>
            {rows}
          </div>
        </div>
        <div className="focus-ring" ref={ringRef} />
      </>
    );
  }),
);
