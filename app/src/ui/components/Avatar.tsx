import { useState } from 'react';

export function Avatar({ name, src, size = 96 }: { name: string; src?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: size * 0.42 };
  if (src && !failed) {
    return <img className="avatar" style={style} src={src} alt="" decoding="async" onError={() => setFailed(true)} />;
  }
  return (
    <div className="avatar avatar-initial" style={style}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </div>
  );
}
