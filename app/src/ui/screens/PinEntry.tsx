import { useState } from 'react';
import { useApp } from '../AppContext';
import { FocusButton, FocusScope } from '../focus/react';

const PIN_LENGTH = 4;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'delete', '0', 'cancel'] as const;

interface PinEntryProps {
  name: string;
  /** Resolves false when the PIN was wrong. */
  onSubmit: (pin: string) => Promise<boolean>;
  onCancel: () => void;
}

export function PinEntry({ name, onSubmit, onCancel }: PinEntryProps) {
  const { t } = useApp();
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  async function press(key: (typeof KEYS)[number]) {
    if (busy) return;
    if (key === 'cancel') return onCancel();
    if (key === 'delete') return setPin((value) => value.slice(0, -1));
    const next = pin + key;
    setWrong(false);
    setPin(next);
    if (next.length < PIN_LENGTH) return;
    setBusy(true);
    const accepted = await onSubmit(next);
    setBusy(false);
    if (!accepted) {
      setWrong(true);
      setPin('');
    }
  }

  return (
    <FocusScope className="overlay" onBack={onCancel} hints={{ b: 'pin.cancel' }}>
      <div className="pin-panel">
        <h2>{t('pin.title', { name })}</h2>
        <div className={wrong ? 'pin-dots wrong' : 'pin-dots'}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span key={i} className={i < pin.length ? 'filled' : ''} />
          ))}
        </div>
        <p className="error pin-error">{wrong ? t('pin.wrong') : ' '}</p>
        <div className="pin-pad">
          {KEYS.map((key) => (
            <FocusButton key={key} autoFocus={key === '5'} className="pin-key" onSelect={() => press(key)}>
              {key === 'delete' ? t('pin.delete') : key === 'cancel' ? t('pin.cancel') : key}
            </FocusButton>
          ))}
        </div>
      </div>
    </FocusScope>
  );
}
