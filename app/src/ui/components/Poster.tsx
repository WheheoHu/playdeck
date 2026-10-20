import { memo, useEffect, useRef } from 'react';

interface PosterProps {
  id: string;
  src?: string;
  title: string;
  progress?: number | null;
  watched?: boolean;
  badge?: string;
  /** Size variant, e.g. "landscape" for episode stills. */
  variant?: string;
}

/**
 * A poster card. Images are decoded off the main thread before being revealed, so a late decode never
 * lands inside an animation frame (docs/DESIGN.md, section 8.2).
 */
export const Poster = memo(function Poster({ id, src, title, progress, watched, badge, variant }: PosterProps) {
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = image.current;
    if (!img || !src) return;
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
    <div className={variant ? `card ${variant}` : 'card'} id={id}>
      <div className="card-fallback">{title}</div>
      {src && <img ref={image} alt="" decoding="async" />}
      {badge && <span className="card-badge">{badge}</span>}
      {watched && <span className="card-watched">✓</span>}
      {progress != null && (
        <span className="card-progress">
          <span style={{ transform: `scaleX(${progress})` }} />
        </span>
      )}
    </div>
  );
});
