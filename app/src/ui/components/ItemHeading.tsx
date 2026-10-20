import { episodeLabel, formatDuration } from '../../core/format';
import { type MediaItem, imageUrl } from '../../core/plex/library';
import { imageScale } from '../layout';
import { useServers } from '../servers';

const LOGO_W = 420;
const LOGO_H = 140;

/** The show/movie logo when Plex has one, else its title, plus a one-line summary of facts. */
export function ItemHeading({ item, badges = [] }: { item: MediaItem; badges?: string[] }) {
  const { byId } = useServers();
  const server = byId(item.serverId);
  const isChild = item.type === 'episode' || item.type === 'season';
  const facts = [
    isChild ? episodeLabel(item) : undefined,
    item.year ? String(item.year) : undefined,
    item.contentRating,
    formatDuration(item.duration),
    item.audienceRating ? `★ ${item.audienceRating.toFixed(1)}` : undefined,
  ].filter(Boolean);

  return (
    <div className="item-heading">
      {item.logo && server && !isChild ? (
        <img className="item-logo" alt={item.title} src={imageUrl(server, item.logo, LOGO_W, LOGO_H, imageScale())} />
      ) : (
        <div className="item-title">{isChild ? (item.grandparentTitle ?? item.parentTitle ?? item.title) : item.title}</div>
      )}
      {isChild && <div className="item-subtitle">{item.title}</div>}
      <div className="item-facts">
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
        {badges.map((badge) => (
          <span key={badge} className="quality-badge">
            {badge}
          </span>
        ))}
      </div>
    </div>
  );
}
