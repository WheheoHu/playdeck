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
  /** Right stick or a scroll wheel: scrolls the focused element's own content. */
  | 'scroll-up'
  | 'scroll-down'
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
const REPEATING = new Set<Action>(['up', 'down', 'left', 'right', 'page-up', 'page-down', 'scroll-up', 'scroll-down']);
const STICK_THRESHOLD = 0.6;
const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 90;
/** A scroll step turns a page, so a held stick turns them slower than the D-pad moves. */
const SCROLL_REPEAT_MS = 300;
/** Wheel travel per scroll step, in pixels; a mouse notch is about 50-120. */
const WHEEL_STEP = 50;
/** One trackpad swipe sends a burst of wheel events; it turns one page. */
const WHEEL_COOLDOWN_MS = 250;
/** After the window shows, the pad's state can lag a few frames behind. */
const PRIME_MS = 300;

function stickActions(pad: Gamepad): Action[] {
  const [x = 0, y = 0, , rightY = 0] = pad.axes;
  const actions: Action[] = [];
  if (x < -STICK_THRESHOLD) actions.push('left');
  if (x > STICK_THRESHOLD) actions.push('right');
  if (y < -STICK_THRESHOLD) actions.push('up');
  if (y > STICK_THRESHOLD) actions.push('down');
  if (rightY < -STICK_THRESHOLD) actions.push('scroll-up');
  if (rightY > STICK_THRESHOLD) actions.push('scroll-down');
  return actions;
}

const repeatInterval = (action: Action) =>
  action === 'scroll-up' || action === 'scroll-down' ? SCROLL_REPEAT_MS : REPEAT_INTERVAL_MS;

/** Keyboard events plus polled gamepads with key-repeat for navigation. Returns a disposer. */
export function listenForActions(onAction: (action: Action) => void): () => void {
  const onKey = (event: KeyboardEvent) => {
    const action = KEYS[event.key];
    if (!action || (event.repeat && !REPEATING.has(action))) return;
    event.preventDefault();
    onAction(action);
  };
  window.addEventListener('keydown', onKey);

  let wheel = 0;
  let wheelQuietUntil = 0;
  const onWheel = (event: WheelEvent) => {
    if (event.timeStamp < wheelQuietUntil) return;
    wheel += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 40 : event.deltaY;
    if (Math.abs(wheel) < WHEEL_STEP) return;
    onAction(wheel > 0 ? 'scroll-down' : 'scroll-up');
    wheel = 0;
    wheelQuietUntil = event.timeStamp + WHEEL_COOLDOWN_MS;
  };
  window.addEventListener('wheel', onWheel, { passive: true });

  const nextRepeat = new Map<Action, number>();
  // Buttons already down when the window shows (the press that stopped playback in mpv, or launched
  // the app) act only after they are released.
  let primeUntil = -Infinity;
  const prime = () => {
    if (document.visibilityState === 'visible') primeUntil = performance.now() + PRIME_MS;
  };
  prime();
  document.addEventListener('visibilitychange', prime);
  window.addEventListener('focus', prime);

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
      if (due === undefined && now < primeUntil) {
        nextRepeat.set(action, Infinity);
      } else if (due === undefined) {
        onAction(action);
        nextRepeat.set(action, REPEATING.has(action) ? now + REPEAT_DELAY_MS : Infinity);
      } else if (now >= due) {
        onAction(action);
        nextRepeat.set(action, now + repeatInterval(action));
      }
    }
    for (const action of nextRepeat.keys()) if (!held.has(action)) nextRepeat.delete(action);
    frame = requestAnimationFrame(poll);
  };
  frame = requestAnimationFrame(poll);

  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('wheel', onWheel);
    document.removeEventListener('visibilitychange', prime);
    window.removeEventListener('focus', prime);
    cancelAnimationFrame(frame);
  };
}
