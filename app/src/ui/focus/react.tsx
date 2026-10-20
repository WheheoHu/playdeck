import {
  type ButtonHTMLAttributes,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type Action, listenForActions } from '../input';
import { type Focusable, type Region, FocusManager } from './manager';

const FocusContext = createContext<FocusManager | null>(null);

export function useFocusManager(): FocusManager {
  const manager = useContext(FocusContext);
  if (!manager) throw new Error('useFocusManager outside FocusProvider');
  return manager;
}

/** Owns the focus engine and routes input to it; actions it does not consume go to `onUnhandled`. */
export function FocusProvider({ children, onUnhandled }: { children: ReactNode; onUnhandled?: (action: Action) => void }) {
  const [manager] = useState(() => new FocusManager(document.body));
  const unhandled = useRef(onUnhandled);
  unhandled.current = onUnhandled;

  useEffect(
    () =>
      listenForActions((action) => {
        if (!manager.handle(action)) unhandled.current?.(action);
      }),
    [manager],
  );

  return <FocusContext.Provider value={manager}>{children}</FocusContext.Provider>;
}

interface FocusScopeProps {
  children: ReactNode;
  className?: string;
  /** B / Escape. */
  onBack?: () => void;
  /** Actions nothing focused inside the scope handled; returns whether it handled one. */
  onAction?: (action: Action) => boolean;
  hidden?: boolean;
}

/** A focus layer. The most recently mounted scope receives input. */
export function FocusScope({ children, className, onBack, onAction, hidden }: FocusScopeProps) {
  const manager = useFocusManager();
  const root = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onBack, onAction });
  handlers.current = { onBack, onAction };

  useLayoutEffect(() => {
    const scope = {
      root: root.current!,
      onBack: () => {
        handlers.current.onBack?.();
        return Boolean(handlers.current.onBack);
      },
      onAction: (action: Action) => handlers.current.onAction?.(action) ?? false,
    };
    manager.pushScope(scope);
    return () => manager.removeScope(scope);
  }, [manager]);

  return (
    <div ref={root} className={className} style={hidden ? { visibility: 'hidden' } : undefined}>
      {children}
    </div>
  );
}

/** Ref callback that makes an element focusable. */
export function useFocusable<T extends HTMLElement>(
  onSelect?: () => void,
  onAction?: Focusable['onAction'],
): (element: T | null) => void {
  const manager = useFocusManager();
  const handlers = useRef({ onSelect, onAction });
  handlers.current = { onSelect, onAction };
  return useCallback(
    (element: T | null) => {
      if (!element) return;
      manager.register(element, {
        onSelect: () => handlers.current.onSelect?.(),
        onAction: (action) => handlers.current.onAction?.(action) ?? false,
      });
    },
    [manager],
  );
}

/** Ref callback that turns an element into a focus region driven by `region`. */
export function useRegion<T extends HTMLElement>(region: Region): (element: T | null) => void {
  const manager = useFocusManager();
  const current = useRef(region);
  current.current = region;
  return useCallback(
    (element: T | null) => {
      if (!element) return;
      manager.registerRegion(element, {
        enter: (direction) => current.current.enter(direction),
        move: (focused, direction) => current.current.move(focused, direction),
        action: (focused, action) => current.current.action?.(focused, action) ?? false,
      });
    },
    [manager],
  );
}

interface FocusButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  onSelect?: () => void;
  onAction?: Focusable['onAction'];
  autoFocus?: boolean;
}

export function FocusButton({ onSelect, onAction, autoFocus, className, children, ...rest }: FocusButtonProps) {
  const ref = useFocusable<HTMLButtonElement>(onSelect, onAction);
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      tabIndex={-1}
      className={className ? `button ${className}` : 'button'}
      data-autofocus={autoFocus ? '' : undefined}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
