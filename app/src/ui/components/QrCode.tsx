import { useMemo } from 'react';
import { renderSVG } from 'uqr';

export function QrCode({ value }: { value: string }) {
  const svg = useMemo(() => renderSVG(value, { border: 2 }), [value]);
  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}
