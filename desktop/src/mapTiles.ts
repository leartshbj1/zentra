/**
 * Carte des chantiers : tuiles OpenStreetMap (gratuites, attribution affichée)
 * et positions trouvées par le service de recherche de la Confédération
 * (geo.admin.ch), seulement quand la personne le demande. Les positions sont
 * gardées sur cet appareil.
 */
export type GeoPoint = { lat: number; lon: number };

const TILE = 256;
export const TILE_URL = 'https://tile.openstreetmap.org';
const GEOCODER = 'https://api3.geo.admin.ch/rest/services/api/SearchServer';
const CACHE_KEY = 'zentra.planning.geocode.v1';
/** Centre de la Suisse, quand aucun chantier n'est placé. */
export const SWITZERLAND: GeoPoint = { lat: 46.8, lon: 8.23 };

export function project(point: GeoPoint, zoom: number) {
  const scale = TILE * 2 ** zoom;
  const sin = Math.sin((Math.max(-85, Math.min(85, point.lat)) * Math.PI) / 180);
  return { x: ((point.lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}

/** Le plus grand zoom (7 à 16) qui montre tous les points avec une marge. */
export function fitZoom(points: readonly GeoPoint[], width: number, height: number, padding = 40): number {
  if (points.length < 2) return points.length ? 13 : 7;
  for (let zoom = 16; zoom > 7; zoom--) {
    const projected = points.map(point => project(point, zoom));
    const spanX = Math.max(...projected.map(p => p.x)) - Math.min(...projected.map(p => p.x));
    const spanY = Math.max(...projected.map(p => p.y)) - Math.min(...projected.map(p => p.y));
    if (spanX <= width - padding * 2 && spanY <= height - padding * 2) return zoom;
  }
  return 7;
}

export function centre(points: readonly GeoPoint[]): GeoPoint {
  if (!points.length) return SWITZERLAND;
  const lats = points.map(point => point.lat), lons = points.map(point => point.lon);
  return { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
}

export type Tile = { key: string; url: string; left: number; top: number };

/** Tuiles nécessaires pour une vue de width × height centrée sur un point. */
export function visibleTiles(center: GeoPoint, zoom: number, width: number, height: number): { tiles: Tile[]; origin: { x: number; y: number } } {
  const middle = project(center, zoom);
  const origin = { x: middle.x - width / 2, y: middle.y - height / 2 };
  const count = 2 ** zoom, tiles: Tile[] = [];
  for (let ty = Math.floor(origin.y / TILE); ty <= Math.floor((origin.y + height) / TILE); ty++) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = Math.floor(origin.x / TILE); tx <= Math.floor((origin.x + width) / TILE); tx++) {
      const wrapped = ((tx % count) + count) % count;
      tiles.push({ key: `${zoom}/${tx}/${ty}`, url: `${TILE_URL}/${zoom}/${wrapped}/${ty}.png`, left: tx * TILE - origin.x, top: ty * TILE - origin.y });
    }
  }
  return { tiles, origin };
}

/** Clé de cache : l'adresse sans espaces superflus, en minuscules. */
export const addressKey = (address: string) => address.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function readGeocodes(): Record<string, GeoPoint | null> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, unknown>;
    const result: Record<string, GeoPoint | null> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const point = value as GeoPoint | null;
      result[key] = point && Number.isFinite(point.lat) && Number.isFinite(point.lon) ? { lat: point.lat, lon: point.lon } : null;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveGeocodes(values: Record<string, GeoPoint | null>) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(values)); } catch { /* La carte reste utilisable sans cache. */ }
}

/** Lit la réponse du service fédéral : premier lieu trouvé, en WGS84. */
export function geocodeResult(body: unknown): GeoPoint | null {
  const first = (body as { results?: Array<{ attrs?: { lat?: unknown; lon?: unknown } }> })?.results?.[0]?.attrs;
  const lat = Number(first?.lat), lon = Number(first?.lon);
  // Seulement la Suisse et ses environs : une réponse ailleurs est ignorée.
  return Number.isFinite(lat) && Number.isFinite(lon) && lat > 45 && lat < 48.5 && lon > 5 && lon < 11.5 ? { lat, lon } : null;
}

export async function geocodeAddress(address: string, fetcher: typeof fetch = fetch): Promise<GeoPoint | null> {
  const url = `${GEOCODER}?type=locations&limit=1&sr=4326&searchText=${encodeURIComponent(address.trim().slice(0, 200))}`;
  const response = await fetcher(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`geo.admin.ch ${response.status}`);
  return geocodeResult(await response.json());
}
