// Handheld layout in logical pixels (docs/DESIGN.md, section 5.1). Mirrored in styles.css.
export const PAD_X = 48;
export const TAB_BAR_H = 72;

/** Seven posters per row: 48 + 7 * 154 + 6 * 18 leaves 46 px on the right, and the eighth peeks in. */
export const POSTER_W = 154;
export const POSTER_H = 231;
export const GAP = 18;
export const STRIDE_X = POSTER_W + GAP;
/** Scale of a focused card; the ring is sized for the scaled card. */
export const FOCUS_SCALE = 1.06;

export const ROW_LABEL_H = 46;
export const ROW_H = ROW_LABEL_H + POSTER_H + 30;
/** Cards to the left of the focused card before a row starts scrolling. */
export const ROW_LEAD = 2;

/** Library grid: fewer, larger posters than the rows, two full rows above the hints bar. */
export const GRID_COLS = 6;
export const GRID_POSTER_W = 168;
export const GRID_POSTER_H = 252;
export const GRID_GAP = 24;
/** Centers the grid: (1280 - 6 * 168 - 5 * 24) / 2. */
export const GRID_PAD_X = 76;
export const GRID_STRIDE_X = GRID_POSTER_W + GRID_GAP;
export const GRID_CAPTION_H = 60;
export const GRID_ROW_H = GRID_POSTER_H + GRID_CAPTION_H + 12;

/** Logical pixels to device pixels, for requesting images at native resolution. */
export const imageScale = () => window.devicePixelRatio || 1;

/** The rect of a card at (x, y) once its focus scale-up has finished. */
export function focusedCardRect(x: number, y: number, width = POSTER_W, height = POSTER_H) {
  const dx = (width * (FOCUS_SCALE - 1)) / 2;
  const dy = (height * (FOCUS_SCALE - 1)) / 2;
  return { left: x - dx, top: y - dy, right: x + width + dx, bottom: y + height + dy };
}
