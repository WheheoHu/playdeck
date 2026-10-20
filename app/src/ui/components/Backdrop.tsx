import { memo, useEffect, useRef } from 'react';
import { backdropOf } from '../../core/home';
import { type MediaItem, type UltraBlur, imageUrl } from '../../core/plex/library';
import { imageScale } from '../layout';
import { useServers } from '../servers';

// The art covers 80% of the handheld layout's width; larger requests only cost decode time.
const ART_W = 1024;
const ART_H = 576;

/**
 * Paints Plex's four UltraBlur corner colours into a 2x2 canvas. The GPU stretches it bilinearly over
 * the screen, so changing colours re-rasterizes nothing (a CSS gradient would repaint a full-screen
 * layer on every focus change).
 */
function paintBlur(canvas: HTMLCanvasElement, blur: UltraBlur | undefined) {
  const context = canvas.getContext('2d')!;
  if (!blur) {
    context.clearRect(0, 0, 2, 2);
    return;
  }
  const corners: [string, number, number][] = [
    [blur.topLeft, 0, 0],
    [blur.topRight, 1, 0],
    [blur.bottomLeft, 0, 1],
    [blur.bottomRight, 1, 1],
  ];
  for (const [color, x, y] of corners) {
    context.fillStyle = `#${color}`;
    context.fillRect(x, y, 1, 1);
  }
}

/** Full-bleed art over UltraBlur colours, cross-faded between two layers (docs/DESIGN.md, section 8.2). */
export const Backdrop = memo(function Backdrop({ item, className }: { item: MediaItem | null; className?: string }) {
  const { byId } = useServers();
  const layers = useRef<(HTMLDivElement | null)[]>([]);
  const active = useRef(0);
  const server = item ? byId(item.serverId) : undefined;
  const art = item ? backdropOf(item) : undefined;
  const src = server && art ? imageUrl(server, art, ART_W, ART_H, imageScale()) : undefined;
  const blur = item?.ultraBlur;
  const blurKey = blur ? `${blur.topLeft}${blur.topRight}${blur.bottomRight}${blur.bottomLeft}` : '';

  useEffect(() => {
    const next = layers.current[1 - active.current];
    const current = layers.current[active.current];
    if (!next || !current) return;
    let cancelled = false;
    const img = next.querySelector('img')!;
    paintBlur(next.querySelector('canvas')!, blur);

    // img.decode() fills Blink's cache, but the GPU rasterizer decodes and uploads again on first draw.
    // Drawing the layer nearly transparent for two frames moves that cost before the fade starts.
    const reveal = () => {
      if (cancelled) return;
      next.classList.add('warming');
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (cancelled) return;
          next.classList.remove('warming');
          next.classList.add('visible');
          current.classList.remove('visible');
          active.current = 1 - active.current;
        }),
      );
    };
    if (src) {
      img.src = src;
      img.decode().then(reveal, reveal);
    } else {
      img.removeAttribute('src');
      reveal();
    }
    return () => {
      cancelled = true;
    };
    // blurKey stands in for the blur object, which is recreated on every parse.
  }, [src, blurKey]);

  return (
    <div className={className ? `backdrop ${className}` : 'backdrop'}>
      {[0, 1].map((index) => (
        <div key={index} className="backdrop-layer" ref={(element) => void (layers.current[index] = element)}>
          <canvas className="backdrop-blur" width={2} height={2} />
          <img alt="" decoding="async" />
        </div>
      ))}
      <div className="backdrop-shade" />
    </div>
  );
});
