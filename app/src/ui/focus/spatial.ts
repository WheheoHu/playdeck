import type { Direction } from '../input';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const ORTHOGONAL_WEIGHT = 3;
// Within the nearest row (or column) ahead, candidates that share a row (or column) with the current
// element beat any that do not.
const NO_OVERLAP_PENALTY = 100_000;
// Candidates beyond the nearest row lose to any in it, so a narrow row of tabs is never skipped for
// a wider row behind it. Rows closer together than this count as one.
const BAND_PX = 16;
const FARTHER_BAND_PENALTY = 10_000_000;

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 1;
}

/** Index of the best candidate in `direction` from `from`, or -1. */
export function pickNext(from: Rect, candidates: Rect[], direction: Direction): number {
  const fromX = (from.left + from.right) / 2;
  const fromY = (from.top + from.bottom) / 2;
  const horizontal = direction === 'left' || direction === 'right';

  // Both edges must lie further in the direction, so a shorter neighbour in a top-aligned row is not
  // "above", nor a narrower one in a left-aligned column "left".
  const ahead = candidates.map((rect) =>
    direction === 'right' ? rect.left >= from.left + 1 && rect.right >= from.right + 1
    : direction === 'left' ? rect.right <= from.right - 1 && rect.left <= from.left - 1
    : direction === 'down' ? rect.top >= from.top + 1 && rect.bottom >= from.bottom + 1
    : rect.bottom <= from.bottom - 1 && rect.top <= from.top - 1,
  );
  const primary = candidates.map((rect) =>
    direction === 'right' ? Math.max(0, rect.left - from.right)
    : direction === 'left' ? Math.max(0, from.left - rect.right)
    : direction === 'down' ? Math.max(0, rect.top - from.bottom)
    : Math.max(0, from.top - rect.bottom),
  );
  const nearest = Math.min(...primary.filter((_, index) => ahead[index]));

  let bestIndex = -1;
  let bestScore = Infinity;
  candidates.forEach((rect, index) => {
    if (!ahead[index]) return;
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    const orthogonal = horizontal ? Math.abs(y - fromY) : Math.abs(x - fromX);
    const aligned = horizontal
      ? overlaps(from.top, from.bottom, rect.top, rect.bottom)
      : overlaps(from.left, from.right, rect.left, rect.right);
    // Left and right stay in the row: the end of a wrapped row is an edge, not a way down.
    if (horizontal && !aligned) return;
    const score =
      primary[index] +
      ORTHOGONAL_WEIGHT * orthogonal +
      (aligned ? 0 : NO_OVERLAP_PENALTY) +
      (primary[index] > nearest + BAND_PX ? FARTHER_BAND_PENALTY : 0);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}
