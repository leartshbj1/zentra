import { describe, expect, it, vi } from 'vitest';
import { addressKey, centre, fitZoom, geocodeAddress, geocodeResult, project, visibleTiles } from './mapTiles';

describe('site map', () => {
  it('projects coordinates like OpenStreetMap tiles', () => {
    const zero = project({ lat: 0, lon: 0 }, 1);
    expect(zero).toEqual({ x: 256, y: 256 });
    // Lausanne à zoom 10 : tuile 530/362 (formule de Slippy Map).
    const lausanne = project({ lat: 46.52, lon: 6.633 }, 10);
    expect([Math.floor(lausanne.x / 256), Math.floor(lausanne.y / 256)]).toEqual([530, 362]);
  });

  it('fits several sites and centres between them', () => {
    const points = [{ lat: 46.52, lon: 6.63 }, { lat: 46.2, lon: 6.14 }];
    const zoom = fitZoom(points, 800, 320);
    expect(zoom).toBeGreaterThanOrEqual(8);
    expect(zoom).toBeLessThanOrEqual(10);
    expect(fitZoom([], 800, 320)).toBe(7);
    expect(fitZoom([points[0]], 800, 320)).toBe(13);
    expect(centre(points)).toEqual({ lat: 46.36, lon: 6.385 });
  });

  it('lists only the tiles of the view', () => {
    const { tiles } = visibleTiles({ lat: 46.52, lon: 6.633 }, 12, 512, 256);
    expect(tiles.length).toBeGreaterThanOrEqual(3);
    expect(tiles.length).toBeLessThanOrEqual(6);
    expect(tiles.every(tile => tile.url.startsWith('https://tile.openstreetmap.org/12/'))).toBe(true);
  });

  it('reads the federal geocoder and ignores places outside Switzerland', async () => {
    expect(geocodeResult({ results: [{ attrs: { lat: 46.383, lon: 6.239 } }] })).toEqual({ lat: 46.383, lon: 6.239 });
    expect(geocodeResult({ results: [{ attrs: { lat: 40.7, lon: -74 } }] })).toBeNull();
    expect(geocodeResult({ results: [] })).toBeNull();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ attrs: { lat: 46.2, lon: 6.14 } }] })));
    expect(await geocodeAddress('Rue du Rhône 1, Genève', fetcher as never)).toEqual({ lat: 46.2, lon: 6.14 });
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toContain('searchText=Rue%20du%20Rh%C3%B4ne%201%2C%20Gen%C3%A8ve');
    expect(addressKey('  Rue  du Lac 4 ')).toBe('rue du lac 4');
  });
});
