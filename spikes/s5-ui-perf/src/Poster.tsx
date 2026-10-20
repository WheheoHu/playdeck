import { memo, useEffect, useRef } from 'react';

interface PosterProps {
  id: string;
  src: string;
}

/** Decodes off the main thread before revealing, so a late decode never lands inside a frame. */
export const Poster = memo(function Poster({ id, src }: PosterProps) {
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = ref.current!;
    let cancelled = false;
    img.classList.remove('loaded');
    img.src = src;
    img
      .decode()
      .then(() => !cancelled && img.classList.add('loaded'))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div className="card" id={id}>
      <img ref={ref} alt="" decoding="async" />
    </div>
  );
});
