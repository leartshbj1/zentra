import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appTourScreens, tourGroups, tourImage } from './app-tour';
import { translateSiteUi } from './site-copy';
import assets from '../docs/app-tour-assets.json';

describe('current app visit', () => {
  it('ships every language, theme and device with its verified real screenshot', () => {
    expect(assets).toHaveLength(appTourScreens.length * 4 * 2 * 2);
    expect(new Set(assets.map((asset) => asset.file)).size).toBe(assets.length);
    for (const asset of assets) {
      expect(existsSync(asset.file), asset.file).toBe(true);
      expect(
        createHash('sha256').update(readFileSync(asset.file)).digest('hex'),
        asset.file,
      ).toBe(asset.sha256);
      expect(asset.width).toBe(asset.file.includes('-desktop.') ? 1440 : 390);
      expect(asset.height).toBe(asset.file.includes('-desktop.') ? 960 : 844);
    }
    for (const screen of appTourScreens)
      for (const language of ['fr', 'de', 'it', 'en'])
        for (const theme of ['light', 'dark'] as const)
          for (const device of ['desktop', 'mobile'] as const) {
            expect(
              assets.some(
                (asset) =>
                  asset.file ===
                  `public${tourImage(screen.id, device, language, theme)}`,
              ),
              `${screen.id}/${language}/${theme}/${device}`,
            ).toBe(true);
          }
  });
  it('includes Notes and stable, unique module identifiers', () => {
    expect(appTourScreens.some((screen) => screen.id === 'notes')).toBe(true);
    expect(new Set(appTourScreens.map((screen) => screen.id)).size).toBe(
      appTourScreens.length,
    );
    for (const screen of appTourScreens)
      expect(tourGroups[screen.group]).toBeTruthy();
  });
  for (const language of ['fr', 'de', 'it', 'en'])
    for (const theme of ['light', 'dark'] as const) {
      it(`${language}/${theme} uses the requested real capture for each device`, () => {
        for (const screen of appTourScreens)
          for (const device of ['desktop', 'mobile'] as const) {
            expect(tourImage(screen.id, device, language, theme)).toBe(
              `/tour/gestion/current/${language}/${theme}/${screen.id}-${device}.webp`,
            );
          }
      });
    }
  it('falls back safely for unknown language and module identifiers', () => {
    expect(tourImage('../../outside', 'mobile', 'unknown', 'dark')).toBe(
      '/tour/gestion/current/fr/dark/accueil-mobile.webp',
    );
  });
  for (const language of ['de', 'it', 'en'] as const)
    it(`translates all tour guidance in ${language}`, () => {
      for (const screen of appTourScreens)
        for (const field of ['title', 'description', 'detail'] as const) {
          expect(
            translateSiteUi(screen[field], language),
            screen[field],
          ).not.toBe(screen[field]);
        }
      for (const text of [
        'Thème de l’aperçu',
        'Voir en mode clair',
        'Voir en mode sombre',
        'Clair',
        'Sombre',
      ]) {
        expect(translateSiteUi(text, language), text).not.toBe(text);
      }
    });
  it('translates the new Notes navigation label and keeps its English name', () => {
    expect(translateSiteUi('Notes', 'de')).toBe('Notizen');
    expect(translateSiteUi('Notes', 'it')).toBe('Note');
    expect(translateSiteUi('Notes', 'en')).toBe('Notes');
  });
});
