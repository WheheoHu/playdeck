import { memo, useEffect, useState } from 'react';
import type { MessageKey } from '../../core/i18n';
import { useApp } from '../AppContext';
import type { FocusManager } from '../focus/manager';
import { useFocusManager } from '../focus/react';

/** Left to right, as in the SteamOS footer: confirm and back sit at the far right. */
const BUTTONS = ['menu', 'lt-rt', 'rs', 'y', 'x', 'a', 'b'] as const;
export type HintButton = (typeof BUTTONS)[number];

/** A controller button drawn like the SteamOS glyphs. */
export function Glyph({ button }: { button: HintButton | 'lb' | 'rb' }) {
  if (button === 'lt-rt') {
    return (
      <>
        <span className="glyph glyph-pill">LT</span>
        <span className="glyph glyph-pill">RT</span>
      </>
    );
  }
  if (button === 'menu') return <span className="glyph glyph-pill">☰</span>;
  if (button === 'rs') return <span className="glyph glyph-stick">R</span>;
  if (button === 'lb' || button === 'rb') return <span className="glyph glyph-pill">{button.toUpperCase()}</span>;
  return <span className="glyph glyph-face">{button.toUpperCase()}</span>;
}

type Hint = [HintButton, MessageKey];

/** The focused element's own hints win over its scope's; A reads "Select" on anything focusable. */
function resolveHints(manager: FocusManager): Hint[] {
  const scope = manager.topScope;
  if (!scope) return [];
  const focused = manager.focused && scope.root.contains(manager.focused) ? manager.focused : null;
  const fromScope = scope.hints?.() ?? {};
  return BUTTONS.flatMap((button): Hint[] => {
    const holder = focused?.closest(`[data-hint-${button}]`);
    const own = holder && scope.root.contains(holder) ? holder.getAttribute(`data-hint-${button}`) : null;
    const label = own ?? fromScope[button] ?? (button === 'a' && focused ? 'hint.select' : undefined);
    return label ? [[button, label as MessageKey]] : [];
  });
}

/** The bottom bar of button hints for whatever has focus, re-rendered only when the hints change. */
export const HintsBar = memo(function HintsBar() {
  const manager = useFocusManager();
  const { t } = useApp();
  const [hints, setHints] = useState<Hint[]>([]);

  useEffect(() => {
    let last = '';
    const update = () => {
      const next = resolveHints(manager);
      const key = next.join('|');
      if (key === last) return;
      last = key;
      setHints(next);
    };
    update();
    return manager.subscribe(update);
  }, [manager]);

  if (hints.length === 0) return null;
  return (
    <footer className="hints-bar">
      {hints.map(([button, label]) => (
        <span key={button} className="hint">
          <Glyph button={button} />
          {t(label)}
        </span>
      ))}
    </footer>
  );
});
