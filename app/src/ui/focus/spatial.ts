import type { Direction } from '../input';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const ORTHOGONAL_WEIGHT = 3;
// Candidates that share a row (or column) with the current element beat any that do not.
const NO_OVERLAP_PENALTY = 100_000;

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 1;
}

/** Index of the best candidate in `direction` from `from`, or -1. */
export function pickNext(from: Rect, candidates: Rect[], direction: Direction): number {
  const fromX = (from.left + from.right) / 2;
  const fromY = (from.top + from.bottom) / 2;
  let bestIndex = -1;
  let bestScore = Infinity;

  candidates.forEach((rect, index) => {
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    const horizontal = direction === 'left' || direction === 'right';
    const ahead =
      direction === 'right' ? x > fromX + 1 && rect.left >= from.left + 1
      : direction === 'left' ? x < fromX - 1 && rect.right <= from.right - 1
      : direction === 'down' ? y > fromY + 1 && rect.top >= from.top + 1
      : y < fromY - 1 && rect.bottom <= from.bottom - 1;
    if (!ahead) return;

    const primary =
      direction === 'right' ? Math.max(0, rect.left - from.right)
      : direction === 'left' ? Math.max(0, from.left - rect.right)
      : direction === 'down' ? Math.max(0, rect.top - from.bottom)
      : Math.max(0, from.top - rect.bottom);
    const orthogonal = horizontal ? Math.abs(y - fromY) : Math.abs(x - fromX);
    const aligned = horizontal
      ? overlaps(from.top, from.bottom, rect.top, rect.bottom)
      : overlaps(from.left, from.right, rect.left, rect.right);
    const score = primary + ORTHOGONAL_WEIGHT * orthogonal + (aligned ? 0 : NO_OVERLAP_PENALTY);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}
