// Handheld layout in logical pixels (docs/DESIGN.md, section 5.1). Mirrored in styles.css.
export const PAD_X = 48;
export const TAB_BAR_H = 72;

export const POSTER_W = 140;
export const POSTER_H = 210;
export const GAP = 16;
export const STRIDE_X = POSTER_W + GAP;
/** Scale of a focused card; the ring is sized for the scaled card. */
export const FOCUS_SCALE = 1.06;

export const ROW_LABEL_H = 34;
export const ROW_H = ROW_LABEL_H + POSTER_H + 30;
/** Cards to the left of the focused card before a row starts scrolling. */
export const ROW_LEAD = 2;

export const GRID_COLS = 7;
export const GRID_CAPTION_H = 52;
export const GRID_ROW_H = POSTER_H + GRID_CAPTION_H + 12;

/** Logical pixels to device pixels, for requesting images at native resolution. */
export const imageScale = () => window.devicePixelRatio || 1;

/** The rect of a card at (x, y) once its focus scale-up has finished. */
export function focusedCardRect(x: number, y: number, width = POSTER_W, height = POSTER_H) {
  const dx = (width * (FOCUS_SCALE - 1)) / 2;
  const dy = (height * (FOCUS_SCALE - 1)) / 2;
  return { left: x - dx, top: y - dy, right: x + width + dx, bottom: y + height + dy };
}
