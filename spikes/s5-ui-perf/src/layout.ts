// Handheld layout, in logical pixels (docs/DESIGN.md, section 5.1).
export const CARD_W = 140;
export const CARD_H = 210;
export const GAP = 16;
export const STRIDE_X = CARD_W + GAP;
export const PAD_X = 48;

export const HERO_H = 330;
export const ROW_LABEL_H = 34;
export const ROW_H = ROW_LABEL_H + CARD_H + 26;
export const HOME_ROWS = 6;
export const HOME_ROW_ITEMS = 30;
/** Cards to the left of the focused card before a row starts scrolling. */
export const ROW_LEAD = 2;

export const GRID_TOP = 96;
/** Room inside clipped viewports so a focused, scaled-up card is not cut off. */
export const FOCUS_BLEED = 12;
export const GRID_COLS = 7;
export const GRID_ROW_H = CARD_H + 32;
export const GRID_ITEMS = 5000;
/** Rows mounted above and below the visible ones. */
export const GRID_OVERSCAN = 2;
export const GRID_VISIBLE_ROWS = 3;

export const FOCUS_MS = 140;
