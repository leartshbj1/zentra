import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, useAppLanguage } from './language';
import { addressKey, centre, fitZoom, geocodeAddress, project, readGeocodes, saveGeocodes, visibleTiles, type GeoPoint } from './mapTiles';

export type MapSite = { id: string; label: string; detail: string; address: string };

/**
 * Carte OpenStreetMap des chantiers. Rien ne part sur le réseau tant que la
 * personne n'a pas demandé à placer les adresses ; les tuiles s'affichent
 * seulement avec des chantiers placés.
 */
export function SiteMap({ sites, onSelect }: { sites: readonly MapSite[]; onSelect?: (id: string) => void }) {
  useAppLanguage();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [geocodes, setGeocodes] = useState(readGeocodes);
  const [zoomShift, setZoomShift] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [failed, setFailed] = useState(false);
  const height = width < 520 ? 240 : 340;
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const update = () => setWidth(Math.max(240, Math.round(node.clientWidth)));
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(node);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const withAddress = sites.filter(site => site.address.trim());
  const placed = withAddress.map(site => ({ site, point: geocodes[addressKey(site.address)] })).filter((row): row is { site: MapSite; point: GeoPoint } => Boolean(row.point));
  const unknown = withAddress.filter(site => !(addressKey(site.address) in geocodes));
  const notFound = withAddress.filter(site => geocodes[addressKey(site.address)] === null);
  const points = placed.map(row => row.point);
  const zoom = Math.max(7, Math.min(17, fitZoom(points, width, height) + zoomShift));
  const view = useMemo(() => visibleTiles(centre(points), zoom, width, height), [JSON.stringify(points), zoom, width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  async function locate() {
    setLocating(true);
    setFailed(false);
    const next = { ...geocodes };
    try {
      // Une adresse à la fois : le service public n'est pas sollicité en rafale.
      for (const site of unknown) next[addressKey(site.address)] = await geocodeAddress(site.address);
    } catch {
      setFailed(true);
    } finally {
      saveGeocodes(next);
      setGeocodes(next);
      setLocating(false);
    }
  }

  const current = placed.find(row => row.site.id === selected)?.site;
  return <section className="site-map" aria-labelledby="site-map-title">
    <div className="site-map__heading">
      <h3 id="site-map-title">{t('Carte des chantiers')}</h3>
      {unknown.length ? <button type="button" className="site-map__link" disabled={locating} onClick={() => void locate()}>{locating ? t('Recherche des adresses…') : t('Placer {n} adresse(s) sur la carte', { n: unknown.length })}</button> : null}
    </div>
    {unknown.length ? <p className="site-map__note">{t('Les adresses sont envoyées au service de recherche de la Confédération (geo.admin.ch) pour trouver leur position, qui reste ensuite sur cet appareil.')}</p> : null}
    {failed ? <p className="site-map__note" role="status">{t('La recherche des adresses n’a pas abouti. Vérifiez la connexion puis réessayez.')}</p> : null}
    <div ref={box} className="site-map__frame" style={{ height }}>
      {placed.length ? <>
        <div className="site-map__tiles" aria-hidden="true">
          {view.tiles.map(tile => <img key={tile.key} src={tile.url} alt="" width={256} height={256} style={{ left: tile.left, top: tile.top }} draggable={false} />)}
        </div>
        {placed.map(({ site, point }, index) => {
          const position = project(point, zoom);
          return <button key={site.id} type="button" className={`site-map__marker${selected === site.id ? ' is-selected' : ''}`} style={{ left: position.x - view.origin.x, top: position.y - view.origin.y }}
            aria-label={`${site.label} · ${site.address}`} onClick={() => { setSelected(site.id); onSelect?.(site.id); }}>{index + 1}</button>;
        })}
        <div className="site-map__zoom">
          <button type="button" aria-label={t('Zoomer')} onClick={() => setZoomShift(value => value + 1)}>+</button>
          <button type="button" aria-label={t('Dézoomer')} onClick={() => setZoomShift(value => value - 1)}>−</button>
        </div>
        <p className="site-map__attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">{t('contributeurs OpenStreetMap')}</a></p>
      </> : <p className="site-map__empty">{withAddress.length ? t('Placez les adresses pour voir les chantiers sur la carte.') : t('Aucun chantier avec une adresse dans cette période.')}</p>}
    </div>
    {current ? <p className="site-map__current" role="status"><strong>{current.label}</strong> · {current.address}</p> : null}
    {placed.length ? <ol className="site-map__legend">
      {placed.map(({ site }) => <li key={site.id}><button type="button" onClick={() => { setSelected(site.id); onSelect?.(site.id); }}><strong>{site.label}</strong><small>{[site.detail, site.address].filter(Boolean).join(' · ')}</small></button></li>)}
    </ol> : null}
    {notFound.length ? <p className="site-map__note">{t('Adresse introuvable : {names}', { names: notFound.map(site => site.label).join(', ') })}</p> : null}
  </section>;
}
