export type Direction = 'left' | 'right' | 'up' | 'down';

/** Pages own their focus state outside React so moving focus never re-renders cards. */
export interface PageHandle {
  move(direction: Direction): void;
}

export function setTransform(element: HTMLElement | null | undefined, x: number, y: number): void {
  if (element) element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

export function moveFocusClass(previousId: string | null, nextId: string): boolean {
  if (previousId) document.getElementById(previousId)?.classList.remove('focused');
  const next = document.getElementById(nextId);
  next?.classList.add('focused');
  return next !== null;
}
