import type { Direction } from './page';

export type Action = Direction | 'next-page' | 'previous-page';

const KEYS: Record<string, Action> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ']': 'next-page',
  '[': 'previous-page',
};

// Standard Gamepad mapping indices, as delivered for the Steam Input virtual controller.
const BUTTONS: [number, Action][] = [
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right'],
  [4, 'previous-page'],
  [5, 'next-page'],
];
const STICK_THRESHOLD = 0.6;
const REPEAT_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 100;

function stickActions(pad: Gamepad): Action[] {
  const [x = 0, y = 0] = pad.axes;
  const actions: Action[] = [];
  if (x < -STICK_THRESHOLD) actions.push('left');
  if (x > STICK_THRESHOLD) actions.push('right');
  if (y < -STICK_THRESHOLD) actions.push('up');
  if (y > STICK_THRESHOLD) actions.push('down');
  return actions;
}

/** Keyboard events plus polled gamepad state with key-repeat semantics. Returns a disposer. */
export function listenForActions(onAction: (action: Action) => void): () => void {
  const onKey = (event: KeyboardEvent) => {
    const action = KEYS[event.key];
    if (action) {
      event.preventDefault();
      onAction(action);
    }
  };
  window.addEventListener('keydown', onKey);

  const nextRepeat = new Map<Action, number>();
  let frame = 0;
  const poll = (now: number) => {
    const active = new Set<Action>();
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      for (const [button, action] of BUTTONS) if (pad.buttons[button]?.pressed) active.add(action);
      for (const action of stickActions(pad)) active.add(action);
    }
    for (const action of active) {
      const due = nextRepeat.get(action);
      if (due === undefined || now >= due) {
        onAction(action);
        nextRepeat.set(action, now + (due === undefined ? REPEAT_DELAY_MS : REPEAT_INTERVAL_MS));
      }
    }
    for (const action of nextRepeat.keys()) if (!active.has(action)) nextRepeat.delete(action);
    frame = requestAnimationFrame(poll);
  };
  frame = requestAnimationFrame(poll);

  return () => {
    window.removeEventListener('keydown', onKey);
    cancelAnimationFrame(frame);
  };
}
