import type { Action, Direction } from '../input';
import { type Rect, pickNext } from './spatial';

export interface Focusable {
  onSelect?: () => void;
  /** Other actions (context, page-up, …) while this element has focus; returns whether it handled one. */
  onAction?: (action: Action) => boolean;
}

/** Where focus goes, and where the element will be once its container's animation settles. */
export interface FocusTarget {
  element: HTMLElement;
  rect?: Rect;
}

/**
 * A collection that manages its own focus (rows, grids). Its children are not individually focusable:
 * spatial navigation sees only the region's root and hands over through `enter`.
 */
export interface Region {
  enter(direction: Direction | null): FocusTarget | null;
  /** Returns null to let focus leave the region. */
  move(current: HTMLElement, direction: Direction): FocusTarget | null;
  action?(current: HTMLElement, action: Action): boolean;
}

/**
 * Button hints by button name (`a`, `b`, `x`, `y`, `lt-rt`, `menu`), each a message key or "" for none.
 * The focused element contributes through `data-hint-<button>` attributes on itself or an ancestor.
 */
export type Hints = Partial<Record<string, string>>;

/** A focus layer: a screen or an overlay. Only the topmost scope receives input. */
export interface Scope {
  root: HTMLElement;
  /** Returns whether it handled B / Escape; unhandled presses fall through to the app. */
  onBack?: () => boolean;
  onAction?: (action: Action) => boolean;
  hints?: () => Hints;
  last?: FocusTarget;
}

const RING_PADDING = 4;
const SCROLL_MARGIN = 48;
let focusSerial = 0;
const DIRECTIONS = new Set<Action>(['up', 'down', 'left', 'right']);

function toRect(rect: DOMRect): Rect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/**
 * Where the element ends up once its own focus transform settles. Focused elements scale by
 * `--focus-scale` around their center, and the transition has only just started when this is read.
 */
function settledRect(element: HTMLElement): Rect {
  const rect = element.getBoundingClientRect();
  const scale = parseFloat(getComputedStyle(element).getPropertyValue('--focus-scale')) || 1;
  const x = (rect.left + rect.right) / 2;
  const y = (rect.top + rect.bottom) / 2;
  const halfWidth = (element.offsetWidth * scale) / 2;
  const halfHeight = (element.offsetHeight * scale) / 2;
  return { left: x - halfWidth, right: x + halfWidth, top: y - halfHeight, bottom: y + halfHeight };
}

/**
 * Imperative focus engine. Focus changes touch only the previous and next element's class, the single
 * focus ring's transform and, when needed, one scroll container's transform. React never re-renders
 * for focus.
 */
export class FocusManager {
  private readonly scopes: Scope[] = [];
  private readonly focusables = new WeakMap<Element, Focusable>();
  private readonly regions = new WeakMap<Element, Region>();
  private readonly scrollOffsets = new WeakMap<Element, number>();
  /** Scopes where the user has moved or selected, so late-loading content must not steal focus. */
  private readonly touched = new WeakSet<Scope>();
  private readonly ring: HTMLElement;
  private readonly observer: MutationObserver;
  /** Watches the focused element's container, so late layout shifts (an image loading) move the ring. */
  private readonly resizeObserver: ResizeObserver;
  private resized: Element | null = null;
  private current: HTMLElement | null = null;
  private repairFrame = 0;
  private readonly listeners = new Set<() => void>();

  constructor(container: HTMLElement) {
    this.ring = document.createElement('div');
    this.ring.className = 'focus-ring';
    container.appendChild(this.ring);
    this.observer = new MutationObserver(() => this.scheduleRepair());
    this.resizeObserver = new ResizeObserver(() => this.scheduleRepair());
    window.addEventListener('resize', () => this.scheduleRepair());
  }

  register(element: HTMLElement, focusable: Focusable): void {
    element.dataset.focusable = '';
    this.focusables.set(element, focusable);
    if (element.hasAttribute('data-autofocus')) this.offerInitial(element);
  }

  registerRegion(root: HTMLElement, region: Region): void {
    root.dataset.region = '';
    this.regions.set(root, region);
    if (root.hasAttribute('data-autofocus')) this.offerInitial(root);
  }

  /**
   * An autofocus element that appeared after its scope opened (content loads late) takes focus,
   * unless the user has already moved in that scope.
   */
  offerInitial(element: HTMLElement): void {
    const scope = this.top();
    if (!scope || this.touched.has(scope) || !scope.root.contains(element)) return;
    const target = this.resolve(element, null);
    if (target) this.focus(target);
  }

  /** Lets the next autofocus element take focus again, e.g. after switching tabs. */
  resetInitial(): void {
    const scope = this.top();
    if (scope) this.touched.delete(scope);
  }

  pushScope(scope: Scope): void {
    const below = this.top();
    if (below && this.current) below.last = { element: this.current };
    this.scopes.push(scope);
    this.observer.observe(scope.root, { childList: true, subtree: true });
    this.focusInitial(scope);
    this.notify();
  }

  removeScope(scope: Scope): void {
    const index = this.scopes.indexOf(scope);
    if (index < 0) return;
    const wasTop = index === this.scopes.length - 1;
    this.scopes.splice(index, 1);
    if (wasTop && this.top()) this.focusInitial(this.top()!);
    this.notify();
  }

  /** Called after focus moves or the top scope changes; returns an unsubscriber. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lets listeners re-read state that changed without focus moving, such as a scope's hints. */
  notify(): void {
    for (const listener of this.listeners) listener();
  }

  get topScope(): Scope | undefined {
    return this.top();
  }

  /** Moves focus to `target`; regions pass the element's settled rect, everything else is measured. */
  focus(target: FocusTarget | null): void {
    const element = target?.element ?? null;
    const moved = element !== this.current;
    if (moved) {
      // An attribute rather than a class: React rewrites className on re-render and would drop it.
      this.current?.removeAttribute('data-focused');
      this.current = element;
      element?.setAttribute('data-focused', '');
      this.watchLayout(element);
      // Read by the development performance harness to tell keys that moved focus from no-ops.
      (globalThis as { __playdeckFocusSerial?: number }).__playdeckFocusSerial = ++focusSerial;
    }
    this.placeRing(target?.rect ?? (element ? this.scrollIntoView(element) : undefined));
    if (moved) this.notify();
  }

  private watchLayout(element: HTMLElement | null): void {
    const container = element && !this.regionRootOf(element) ? (element.closest('.scroll-content') ?? element.parentElement) : null;
    if (container === this.resized) return;
    if (this.resized) this.resizeObserver.unobserve(this.resized);
    this.resized = container;
    if (container) this.resizeObserver.observe(container);
  }

  get focused(): HTMLElement | null {
    return this.current;
  }

  /** Re-places the ring, e.g. after a region re-laid out its focused element. */
  refresh(target?: FocusTarget): void {
    if (target && target.element === this.current) this.placeRing(target.rect);
    else this.scheduleRepair();
  }

  handle(action: Action): boolean {
    const scope = this.top();
    if (!scope) return false;
    if (action === 'back') return scope.onBack?.() ?? false;
    if (DIRECTIONS.has(action) || action === 'select') this.touched.add(scope);
    if (DIRECTIONS.has(action)) {
      this.move(scope, action as Direction);
      return true;
    }
    const current = this.current && scope.root.contains(this.current) ? this.current : null;
    if (current) {
      const region = this.regionOf(current);
      if (region?.action?.(current, action)) return true;
      const focusable = this.focusables.get(current);
      if (action === 'select' && focusable?.onSelect) {
        focusable.onSelect();
        return true;
      }
      if (focusable?.onAction?.(action)) return true;
    }
    return scope.onAction?.(action) ?? false;
  }

  private top(): Scope | undefined {
    return this.scopes.at(-1);
  }

  private regionRootOf(element: HTMLElement): HTMLElement | null {
    return element.closest<HTMLElement>('[data-region]');
  }

  private regionOf(element: HTMLElement): Region | undefined {
    const root = this.regionRootOf(element);
    return root ? this.regions.get(root) : undefined;
  }

  /** Focusable elements and region roots in a scope, excluding anything inside a region. */
  private candidates(scope: Scope): HTMLElement[] {
    return [...scope.root.querySelectorAll<HTMLElement>('[data-focusable], [data-region]')].filter((element) => {
      if (!element.isConnected || element.getClientRects().length === 0 || element.hasAttribute('disabled')) return false;
      const parentRegion = element.parentElement?.closest('[data-region]');
      return !parentRegion || !scope.root.contains(parentRegion);
    });
  }

  private resolve(element: HTMLElement, direction: Direction | null): FocusTarget | null {
    const region = this.regions.get(element);
    return region ? region.enter(direction) : { element };
  }

  private focusInitial(scope: Scope): void {
    const remembered = scope.last?.element;
    if (remembered?.isConnected && scope.root.contains(remembered)) return this.focus({ element: remembered });
    const candidates = this.candidates(scope);
    const first = candidates.find((e) => e.hasAttribute('data-autofocus')) ?? candidates[0];
    this.focus(first ? this.resolve(first, null) : null);
  }

  private move(scope: Scope, direction: Direction): void {
    const current = this.current;
    if (!current || !current.isConnected || !scope.root.contains(current)) return this.focusInitial(scope);

    const regionRoot = this.regionRootOf(current);
    if (regionRoot) {
      const inside = this.regions.get(regionRoot)?.move(current, direction);
      if (inside) return this.focus(inside);
    }
    const from = regionRoot ?? current;
    const candidates = this.candidates(scope).filter((element) => element !== from);
    const index = pickNext(
      toRect(current.getBoundingClientRect()),
      candidates.map((element) => toRect(element.getBoundingClientRect())),
      direction,
    );
    if (index < 0) return;
    // Entering a [data-focus-group] from outside lands on its [data-focus-entry], e.g. the selected tab.
    let next = candidates[index];
    const group = next.closest('[data-focus-group]');
    const entry = group && !group.contains(from) ? group.querySelector<HTMLElement>('[data-focus-entry]') : null;
    if (entry && candidates.includes(entry)) next = entry;
    const target = this.resolve(next, direction);
    if (target) this.focus(target);
  }

  /**
   * Containers marked [data-scroll="y"|"x"] scroll by translating their first child, using the same
   * transition as the ring, so content and ring arrive together. Returns the element's settled rect.
   */
  private scrollIntoView(element: HTMLElement): Rect {
    const rect = settledRect(element);
    const container = element.closest<HTMLElement>('[data-scroll]');
    const content = container?.firstElementChild as HTMLElement | null;
    if (!container || !content) return rect;

    const vertical = container.dataset.scroll !== 'x';
    const box = container.getBoundingClientRect();
    const contentBox = content.getBoundingClientRect();
    const offset = this.scrollOffsets.get(container) ?? 0;
    const start = vertical ? rect.top - contentBox.top : rect.left - contentBox.left;
    const end = vertical ? rect.bottom - contentBox.top : rect.right - contentBox.left;
    const viewport = vertical ? box.height : box.width;
    const total = vertical ? content.scrollHeight : content.scrollWidth;

    let next = offset;
    if (start - next < SCROLL_MARGIN) next = start - SCROLL_MARGIN;
    if (end - next > viewport - SCROLL_MARGIN) next = end - viewport + SCROLL_MARGIN;
    next = Math.max(0, Math.min(next, Math.max(0, total - viewport)));
    if (next !== offset) {
      this.scrollOffsets.set(container, next);
      content.style.transform = vertical ? `translate3d(0, ${-next}px, 0)` : `translate3d(${-next}px, 0, 0)`;
    }

    // The content's transform may be mid-transition, so its own rect cannot tell where it will settle.
    // Its offset can (containers are positioned, see styles.css), and includes margins that collapse
    // through it.
    const inset = vertical ? container.clientTop + content.offsetTop : container.clientLeft + content.offsetLeft;
    const origin = (vertical ? box.top : box.left) + inset - next;
    const size = end - start;
    return vertical
      ? { left: rect.left, right: rect.right, top: origin + start, bottom: origin + start + size }
      : { top: rect.top, bottom: rect.bottom, left: origin + start, right: origin + start + size };
  }

  private scheduleRepair(): void {
    cancelAnimationFrame(this.repairFrame);
    this.repairFrame = requestAnimationFrame(() => {
      const scope = this.top();
      if (!scope) return;
      const current = this.current;
      if (!current || !current.isConnected || !scope.root.contains(current)) this.focusInitial(scope);
      // Regions place their own ring; anything else is re-measured in case the layout moved under it.
      else if (!this.regionRootOf(current)) this.placeRing(this.scrollIntoView(current));
    });
  }

  private placeRing(rect: Rect | undefined): void {
    const element = this.current;
    if (!element || !rect) {
      this.ring.style.opacity = '0';
      return;
    }
    const radius = getComputedStyle(element).borderRadius;
    this.ring.style.opacity = '1';
    this.ring.style.width = `${rect.right - rect.left + 2 * RING_PADDING}px`;
    this.ring.style.height = `${rect.bottom - rect.top + 2 * RING_PADDING}px`;
    this.ring.style.borderRadius = `calc(${radius} + ${RING_PADDING}px)`;
    this.ring.style.transform = `translate3d(${rect.left - RING_PADDING}px, ${rect.top - RING_PADDING}px, 0)`;
  }
}
