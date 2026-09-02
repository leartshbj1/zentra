import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_NAVIGATION_QUERY,
  compactSidebarHidden,
} from './compactNavigation';

describe('fenêtre desktop responsive', () => {
  it('autorise réellement le breakpoint de navigation compacte', () => {
    const tauri = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as { app: { windows: Array<{ minWidth: number }> } };
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

    expect(tauri.app.windows[0]?.minWidth).toBe(720);
    expect(tauri.app.windows[0]?.minWidth).toBeLessThanOrEqual(860);
    expect(css).toContain('@media (max-width: 860px)');
    expect(css).toContain('.sidebar.is-open');
    expect(css).toMatch(/\.app-main\s*\{\s*padding-left:\s*0;/);
  });

  it('retire la navigation fermée de l’accessibilité uniquement en mode compact', () => {
    const source = readFileSync(new URL('./WorkspaceApp.tsx', import.meta.url), 'utf8');

    expect(COMPACT_NAVIGATION_QUERY).toBe('(max-width: 860px)');
    expect(compactSidebarHidden(true, false)).toBe(true);
    expect(compactSidebarHidden(true, true)).toBe(false);
    expect(compactSidebarHidden(false, false)).toBe(false);
    expect(source).toContain('inert={sidebarHidden ? true : undefined}');
    expect(source).toContain('aria-hidden={sidebarHidden ? true : undefined}');
    expect(source).toContain('aria-label="Ouvrir la navigation"');
    expect(source).toContain('title="Ouvrir la navigation"');
    expect(source).toContain('aria-label="Fermer la navigation"');
    expect(source).toContain('title="Fermer la navigation"');
  });

  it('garde la checklist de démarrage lisible et calme dans une fenêtre étroite', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

    expect(css).toMatch(
      /@media \(max-width: 860px\)[\s\S]*?\.getting-started__steps\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,/,
    );
    expect(css).toMatch(
      /@media \(max-width: 620px\)[\s\S]*?\.getting-started__next \.button\s*\{[\s\S]*?width:\s*100%;/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.panel\.getting-started,[\s\S]*?animation:\s*none !important;/,
    );
  });
});
