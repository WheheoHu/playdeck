import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { HERO_H, PAD_X, ROW_H, ROW_LABEL_H, ROW_LEAD, STRIDE_X, CARD_H, CARD_W } from './layout';
import { type Direction, type PageHandle, moveFocusClass, setTransform } from './page';
import { type Item, photoUrl } from './plex';
import { Poster } from './Poster';

export interface HomeRow {
  title: string;
  items: Item[];
}

interface HomeProps {
  config: PlayDeckConfig;
  rows: HomeRow[];
}

const HERO_DEBOUNCE_MS = 200;
const cardId = (row: number, col: number) => `h-${row}-${col}`;

export const Home = memo(
  forwardRef<PageHandle, HomeProps>(function Home({ config, rows }, ref) {
    const rowsRef = useRef<HTMLDivElement>(null);
    const trackRefs = useRef<(HTMLDivElement | null)[]>([]);
    const ringRef = useRef<HTMLDivElement>(null);
    const heroRefs = useRef<(HTMLImageElement | null)[]>([]);
    const titleRef = useRef<HTMLDivElement>(null);
    const state = useRef({ row: 0, cols: rows.map(() => 0), focusedId: null as string | null, heroLayer: 0, heroTimer: 0 });

    function showHero(item: Item) {
      const s = state.current;
      window.clearTimeout(s.heroTimer);
      s.heroTimer = window.setTimeout(() => {
        const next = heroRefs.current[1 - s.heroLayer]!;
        const current = heroRefs.current[s.heroLayer]!;
        next.src = photoUrl(config, item.art ?? item.thumb, 1280, 720);
        next
          .decode()
          .then(() => {
            next.classList.add('visible');
            current.classList.remove('visible');
            s.heroLayer = 1 - s.heroLayer;
            if (titleRef.current) titleRef.current.textContent = item.year ? `${item.title} (${item.year})` : item.title;
          })
          .catch(() => {});
      }, HERO_DEBOUNCE_MS);
    }

    function apply() {
      const s = state.current;
      const col = s.cols[s.row];
      const scroll = Math.max(0, col - ROW_LEAD);
      setTransform(rowsRef.current, 0, -s.row * ROW_H);
      setTransform(trackRefs.current[s.row], -scroll * STRIDE_X, 0);
      setTransform(ringRef.current, PAD_X + (col - scroll) * STRIDE_X, HERO_H + ROW_LABEL_H);
      const id = cardId(s.row, col);
      moveFocusClass(s.focusedId, id);
      s.focusedId = id;
      showHero(rows[s.row].items[col]);
    }

    useLayoutEffect(apply, []);

    useImperativeHandle(ref, () => ({
      move(direction: Direction) {
        const s = state.current;
        const before = `${s.row}:${s.cols[s.row]}`;
        if (direction === 'up') s.row = Math.max(0, s.row - 1);
        if (direction === 'down') s.row = Math.min(rows.length - 1, s.row + 1);
        if (direction === 'left') s.cols[s.row] = Math.max(0, s.cols[s.row] - 1);
        if (direction === 'right') s.cols[s.row] = Math.min(rows[s.row].items.length - 1, s.cols[s.row] + 1);
        if (`${s.row}:${s.cols[s.row]}` !== before) apply();
      },
    }));

    return (
      <>
        <div className="hero">
          <img ref={(el) => void (heroRefs.current[0] = el)} alt="" decoding="async" />
          <img ref={(el) => void (heroRefs.current[1] = el)} alt="" decoding="async" />
          <div className="hero-title" ref={titleRef} />
        </div>
        <div className="rows-viewport">
          <div className="rows" ref={rowsRef}>
            {rows.map((row, r) => (
              <section className="row" key={row.title}>
                <div className="row-label">{row.title}</div>
                <div className="track" ref={(el) => void (trackRefs.current[r] = el)}>
                  {row.items.map((item, c) => (
                    <Poster key={c} id={cardId(r, c)} src={photoUrl(config, item.thumb, CARD_W, CARD_H)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="focus-ring" ref={ringRef} />
      </>
    );
  }),
);
