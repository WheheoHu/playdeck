export type Direction = 'up' | 'down' | 'left' | 'right';
export type Action =
  | Direction
  | 'select'
  | 'back'
  | 'context'
  | 'search'
  | 'previous-tab'
  | 'next-tab'
  | 'page-up'
  | 'page-down'
  | 'menu';

// Defaults from docs/DESIGN.md, section 7.2.
const KEYS: Record<string, Action> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  Escape: 'back',
  Backspace: 'back',
  BrowserBack: 'back',
  ContextMenu: 'context',
  PageUp: 'page-up',
  PageDown: 'page-down',
  '[': 'previous-tab',
  ']': 'next-tab',
  '/': 'search',
  F1: 'menu',
};

// Standard Gamepad mapping, which is what the Steam Input virtual controller presents.
const BUTTONS: [number, Action][] = [
  [0, 'select'],
  [1, 'back'],
  [2, 'context'],
  [3, 'search'],
  [4, 'previous-tab'],
  [5, 'next-tab'],
  [6, 'page-up'],
  [7, 'page-down'],
  [9, 'menu'],
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right'],
];
const REPEATING = new Set<Action>(['up', 'down', 'left', 'right', 'page-up', 'page-down']);
const STICK_THRESHOLD = 0.6;
const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 90;

function stickActions(pad: Gamepad): Action[] {
  const [x = 0, y = 0] = pad.axes;
  const actions: Action[] = [];
  if (x < -STICK_THRESHOLD) actions.push('left');
  if (x > STICK_THRESHOLD) actions.push('right');
  if (y < -STICK_THRESHOLD) actions.push('up');
  if (y > STICK_THRESHOLD) actions.push('down');
  return actions;
}

/** Keyboard events plus polled gamepads with key-repeat for navigation. Returns a disposer. */
export function listenForActions(onAction: (action: Action) => void): () => void {
  const onKey = (event: KeyboardEvent) => {
    const action = KEYS[event.key];
    if (!action || (event.repeat && !REPEATING.has(action))) return;
    event.preventDefault();
    onAction(action);
  };
  window.addEventListener('keydown', onKey);

  const nextRepeat = new Map<Action, number>();
  let frame = 0;
  const poll = (now: number) => {
    const held = new Set<Action>();
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      for (const [button, action] of BUTTONS) if (pad.buttons[button]?.pressed) held.add(action);
      for (const action of stickActions(pad)) held.add(action);
    }
    for (const action of held) {
      const due = nextRepeat.get(action);
      if (due === undefined) {
        onAction(action);
        nextRepeat.set(action, REPEATING.has(action) ? now + REPEAT_DELAY_MS : Infinity);
      } else if (now >= due) {
        onAction(action);
        nextRepeat.set(action, now + REPEAT_INTERVAL_MS);
      }
    }
    for (const action of nextRepeat.keys()) if (!held.has(action)) nextRepeat.delete(action);
    frame = requestAnimationFrame(poll);
  };
  frame = requestAnimationFrame(poll);

  return () => {
    window.removeEventListener('keydown', onKey);
    cancelAnimationFrame(frame);
  };
}
