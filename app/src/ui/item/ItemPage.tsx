import { useEffect, useRef, useState } from 'react';
import { episodeLabel, formatDuration, qualityBadges } from '../../core/format';
import { progressOf } from '../../core/home';
import { type MediaItem, fetchChildren, fetchItem, imageUrl } from '../../core/plex/library';
import { useApp } from '../AppContext';
import { Backdrop } from '../components/Backdrop';
import { ItemHeading } from '../components/ItemHeading';
import { FocusButton, FocusScope, useFocusManager, useFocusable } from '../focus/react';
import { imageScale } from '../layout';
import { type Route, isWatched, useNav } from '../nav';
import { useResource } from '../resource';
import { useServers } from '../servers';
import { Credits, ItemActions } from './ItemActions';

const THUMB_W = 192;
const THUMB_H = 108;

function EpisodeRow({ episode, onSelect }: { episode: MediaItem; onSelect: () => void }) {
  const { byId } = useServers();
  const nav = useNav();
  const ref = useFocusable<HTMLDivElement>(onSelect, (action) => {
    if (action !== 'context') return false;
    nav.menu(episode);
    return true;
  });
  const server = byId(episode.serverId);
  const progress = progressOf(episode);
  return (
    <div ref={ref} id={`episode-${episode.ratingKey}`} className="episode-row">
      <div className="episode-thumb">
        {server && episode.thumb && (
          <img alt="" decoding="async" src={imageUrl(server, episode.thumb, THUMB_W, THUMB_H, imageScale())} />
        )}
        {progress !== null && (
          <span className="card-progress">
            <span style={{ transform: `scaleX(${progress})` }} />
          </span>
        )}
        {isWatched(episode) && <span className="card-watched">✓</span>}
      </div>
      <div className="episode-text">
        <div className="episode-title">
          <span className="muted">{episodeLabel(episode)}</span> {episode.title}
        </div>
        <div className="muted episode-meta">{formatDuration(episode.duration)}</div>
        {episode.summary && <p className="episode-summary">{episode.summary}</p>}
      </div>
    </div>
  );
}

function EpisodeOverlay({ episode, onClose }: { episode: MediaItem; onClose: () => void }) {
  const { byId } = useServers();
  const server = byId(episode.serverId);
  return (
    <FocusScope className="overlay" onBack={onClose}>
      <div className="episode-panel">
        {server && episode.thumb && (
          <img className="episode-still" alt="" src={imageUrl(server, episode.thumb, 480, 270, imageScale())} />
        )}
        <ItemHeading item={episode} />
        {episode.summary && <p className="item-summary">{episode.summary}</p>}
        <ItemActions item={episode} autoFocus />
      </div>
    </FocusScope>
  );
}

function Seasons({ show, route }: { show: MediaItem; route: Extract<Route, { kind: 'item' }> }) {
  const { plex, t } = useApp();
  const { byId } = useServers();
  const manager = useFocusManager();
  const server = byId(show.serverId);
  const seasons = useResource(server ? `children:${show.serverId}:${show.ratingKey}` : null, () =>
    fetchChildren(plex, server!, show.ratingKey),
  );
  const [chosen, setChosen] = useState(route.season);
  const active =
    chosen ??
    seasons.data?.find((season) => (season.viewedLeafCount ?? 0) < (season.leafCount ?? 0))?.ratingKey ??
    seasons.data?.[0]?.ratingKey;
  const episodes = useResource(server && active ? `children:${show.serverId}:${active}` : null, () =>
    fetchChildren(plex, server!, active!),
  );
  const [episode, setEpisode] = useState<MediaItem | null>(null);
  const jumped = useRef(false);

  useEffect(() => {
    if (jumped.current || !route.episode || !episodes.data) return;
    const element = document.getElementById(`episode-${route.episode}`);
    if (element) {
      jumped.current = true;
      manager.focus({ element });
    }
  }, [episodes.data, route.episode, manager]);

  if (!seasons.data?.length) return null;
  return (
    <>
      <div className="season-tabs" data-scroll="x">
        <div className="scroll-content row-content">
          {seasons.data.map((season) => (
            <FocusButton
              key={season.ratingKey}
              className={season.ratingKey === active ? 'season-tab selected' : 'season-tab'}
              onSelect={() => setChosen(season.ratingKey)}
            >
              {season.title}
            </FocusButton>
          ))}
        </div>
      </div>
      <div className="episode-list">
        {episodes.loading && <p className="muted">{t('app.loading')}</p>}
        {episodes.data?.map((item) => (
          <EpisodeRow key={item.ratingKey} episode={item} onSelect={() => setEpisode(item)} />
        ))}
      </div>
      {episode && <EpisodeOverlay episode={episode} onClose={() => setEpisode(null)} />}
    </>
  );
}

export function ItemPage({ route }: { route: Extract<Route, { kind: 'item' }> }) {
  const { plex, t } = useApp();
  const { byId } = useServers();
  const nav = useNav();
  const server = byId(route.serverId);
  const resource = useResource(server ? `item:${route.serverId}:${route.ratingKey}` : null, () =>
    fetchItem(plex, server!, route.ratingKey),
  );
  const item = resource.data;

  return (
    <FocusScope className="page item-page" onBack={nav.pop}>
      <Backdrop item={item ?? null} className="page-backdrop" />
      {!item ? (
        <p className="page-message muted">{resource.error ? t('item.loadFailed') : t('app.loading')}</p>
      ) : (
        <div className="item-body" data-scroll="y">
          <div className="scroll-content">
            <ItemHeading item={item} badges={qualityBadges(item)} />
            {item.tagline && <p className="item-tagline">{item.tagline}</p>}
            {item.summary && <p className="item-summary">{item.summary}</p>}
            <Credits item={item} />
            <ItemActions item={item} autoFocus={!route.episode} />
            {item.type === 'show' && <Seasons show={item} route={route} />}
          </div>
        </div>
      )}
    </FocusScope>
  );
}
