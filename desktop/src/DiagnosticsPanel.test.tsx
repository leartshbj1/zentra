import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { AppLanguage } from './language';

// A small hook host lets us exercise the real panel callbacks and asynchronous
// races without adding a browser DOM dependency to the desktop test suite.
const host = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, language: 'fr' as 'fr'|'de'|'it'|'en' }));
const api = vi.hoisted(() => ({ summary: vi.fn(), export: vi.fn(), clear: vi.fn(), mobile: false, share: vi.fn(), openFolder: vi.fn(), clipboard: vi.fn() }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = host.cursor++;
      if (!(index in host.values)) host.values[index] = typeof initial === 'function' ? initial() : initial;
      return [host.values[index], (next: unknown) => { host.values[index] = typeof next === 'function' ? next(host.values[index]) : next; }];
    },
    useRef: (initial: unknown) => {
      const index = host.cursor++;
      if (!(index in host.values)) host.values[index] = { current: initial };
      return host.values[index];
    },
    useEffect: (effect: () => void) => {
      const index = host.cursor++;
      if (!(index in host.values)) { host.values[index] = true; host.effects.push(effect); }
    },
  };
});
vi.mock('./language', () => ({ useAppLanguage: () => host.language, getAppLanguage: () => host.language, t: (source: string) => source }));
vi.mock('./diagnostics', () => ({ diagnosticsApi: api, resolveErrorIncident: () => ({ code: 'ZT-safe-incident' }) }));
vi.mock('./bridge', () => ({ desktopApi: { openDataFolder: api.openFolder } }));
vi.mock('./mobileRuntime', () => ({ isMobileRuntime: () => api.mobile, shareMobileExport: api.share }));
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { Button } from './ui';
import { ErrorGuidance } from './ErrorGuidance';
import type { DiagnosticsSummary } from './diagnostics';

const summary: DiagnosticsSummary = {
  sessionId: 'safe-session', appVersion: '1.90.12', platform: 'windows', eventCount: 7,
  fileCount: 1, sizeBytes: 2_048, maxFileBytes: 262_144, maxFiles: 4,
  firstEventAt: '2026-10-01T12:00:00Z', lastEventAt: '2026-10-01T12:01:00Z',
  lastIncident: { id: 'incident-7', sessionId: 'safe-session', timestamp: '2026-10-01T12:01:00Z', area: 'command', operation: 'save_invoice', phase: 'failure', errorCode: 'CONFLICT' },
};
function render() { host.cursor = 0; const tree = DiagnosticsPanel(); for (const effect of host.effects.splice(0)) effect(); return tree; }
function children(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(children);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...children(element.props.children)];
}
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as ReactElement<{children?:ReactNode}>).props.children);
  return '';
}
function buttons(tree: ReactNode, label: string) { return children(tree).filter(element => element.type === Button && textOf((element.props as {children?:ReactNode}).children) === label); }
function click(tree: ReactNode, label: string, index = 0) {
  const button = buttons(tree, label)[index];
  expect(button, label).toBeDefined();
  const props = button.props as { disabled?: boolean; onClick: () => void };
  expect(props.disabled, label).not.toBe(true);
  props.onClick();
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  host.values = []; host.cursor = 0; host.effects = []; host.language = 'fr'; api.mobile = false;
  api.summary.mockReset().mockResolvedValue(summary);
  api.export.mockReset().mockResolvedValue('/exports/diagnostics.zip');
  api.clear.mockReset().mockResolvedValue(undefined);
  api.share.mockReset().mockResolvedValue(undefined);
  api.openFolder.mockReset().mockResolvedValue(undefined);
  api.clipboard.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: api.clipboard } });
});
afterEach(() => vi.unstubAllGlobals());

describe('diagnostic local et actions de récupération', () => {
  it('lit le journal puis montre le nombre d’événements et la référence', async () => {
    const initial = render();
    expect(textOf(initial)).toContain('Lecture du journal');
    await settle();
    const tree = render();
    expect(api.summary).toHaveBeenCalledOnce();
    expect(textOf(tree)).toContain('7 événements');
    expect(textOf(tree)).toContain('ZT-incident-7');
  });

  it('copie seulement la référence et confirme la copie', async () => {
    render(); await settle(); click(render(), 'Copier la référence'); await settle();
    expect(api.clipboard).toHaveBeenCalledExactlyOnceWith('ZT-incident-7');
    expect(textOf(render())).toContain('Référence copiée.');
  });

  it('garde la référence sélectionnable quand la copie est indisponible', async () => {
    vi.stubGlobal('navigator', {});
    render(); await settle(); click(render(), 'Copier la référence'); await settle();
    expect(textOf(render())).toContain('La référence ne peut pas être copiée');
    expect(textOf(render())).toContain('ZT-incident-7');
  });

  it('ne lance qu’un export sur deux clics rapides et bloque les autres actions pendant l’export', async () => {
    const pending = deferred<string>(); api.export.mockReturnValue(pending.promise);
    render(); await settle(); const tree = render();
    click(tree, 'Exporter le diagnostic'); click(tree, 'Exporter le diagnostic');
    expect(api.export).toHaveBeenCalledOnce();
    const busyTree = render();
    for (const label of ['Exporter le diagnostic', 'Actualiser', 'Effacer le journal']) expect((buttons(busyTree, label)[0].props as {disabled:boolean}).disabled).toBe(true);
    pending.resolve('/exports/diagnostics.zip'); await settle();
    expect(textOf(render())).toContain('Diagnostic exporté.');
    expect(api.summary).toHaveBeenCalledTimes(2);
  });

  it('ne supprime le journal qu’après confirmation explicite', async () => {
    render(); await settle(); click(render(), 'Effacer le journal');
    expect(api.clear).not.toHaveBeenCalled();
    let tree = render(); expect(textOf(tree)).toContain('Effacer les événements de diagnostic ?');
    click(tree, 'Annuler'); expect(api.clear).not.toHaveBeenCalled();
    click(render(), 'Effacer le journal'); tree = render(); click(tree, 'Effacer le journal', 1); await settle();
    expect(api.clear).toHaveBeenCalledOnce();
    expect(textOf(render())).toContain('Journal effacé.');
  });

  it('permet de récupérer un journal illisible sans effacement avant confirmation', async () => {
    api.summary.mockRejectedValueOnce(new Error('synthetic storage read failure'));
    render(); await settle();
    const failed = render();
    expect((buttons(failed, 'Exporter le diagnostic')[0].props as {disabled:boolean}).disabled).toBe(true);
    click(failed, 'Effacer le journal');
    expect(api.clear).not.toHaveBeenCalled();
    click(render(), 'Annuler');
    expect(api.clear).not.toHaveBeenCalled();
    click(render(), 'Effacer le journal');
    api.summary.mockResolvedValue({...summary, eventCount: 0, lastIncident: null});
    click(render(), 'Effacer le journal', 1); await settle();
    expect(api.clear).toHaveBeenCalledOnce();
    expect(api.summary).toHaveBeenCalledTimes(2);
    expect(api.export).not.toHaveBeenCalled();
    expect(textOf(render())).toContain('Journal effacé.');
    expect(textOf(render())).toContain('0 événements');
  });

  it('garde l’effacement non confirmé en échec sans le rejouer lors de la relecture', async () => {
    api.summary.mockRejectedValueOnce(new Error('synthetic storage read failure'));
    api.clear.mockRejectedValueOnce(new Error('synthetic clear failure'));
    render(); await settle(); click(render(), 'Effacer le journal');
    click(render(), 'Effacer le journal', 1); await settle();
    const failed = render();
    const guidance = children(failed).find(element => element.type === ErrorGuidance);
    expect(guidance!.props).toMatchObject({operation: 'mutation', fallback: 'L’effacement du journal n’a pas pu être confirmé.'});
    expect(textOf(failed)).not.toContain('Journal effacé.');
    expect(api.clear).toHaveBeenCalledOnce();
    (guidance!.props as {onReload: () => void}).onReload(); await settle();
    expect(api.summary).toHaveBeenCalledTimes(2);
    expect(api.clear).toHaveBeenCalledOnce();
  });

  it('garde une erreur inconnue et ses secrets hors de l’explication principale', async () => {
    api.summary.mockRejectedValue(new Error('internal panic password=secret alice@example.ch'));
    render(); await settle(); const html = renderToStaticMarkup(render());
    expect(html).toContain('Le journal ne peut pas être lu pour le moment.');
    expect(html).not.toContain('password=secret');
    expect(html).not.toContain('alice@example.ch');
    expect(html).toContain('ZT-safe-incident');
    expect(html).toContain('Détails techniques');
  });

  it.each([
    ['de', 'Das Protokoll kann derzeit nicht gelesen werden.'],
    ['it', 'Il registro non può essere letto al momento.'],
    ['en', 'The log cannot be read right now.'],
  ])('traduit aussi une erreur de lecture déjà affichée après passage à %s', async (language, expected) => {
    api.summary.mockRejectedValue(new Error('synthetic unrecognized failure'));
    render(); await settle();
    host.language = language as AppLanguage;
    const html = renderToStaticMarkup(render());
    expect(html).toContain(expected);
    expect(html).not.toContain('Le journal ne peut pas être lu pour le moment.');
  });

  it('traduit les échecs d’export et de partage déjà reçus sans relancer les actions', async () => {
    api.export.mockRejectedValueOnce(new Error('synthetic unrecognized failure'));
    render(); await settle(); click(render(), 'Exporter le diagnostic'); await settle();
    host.language = 'de';
    expect(renderToStaticMarkup(render())).toContain('Die Diagnose konnte nicht exportiert werden.');
    expect(api.export).toHaveBeenCalledOnce();
    host.language = 'fr'; api.mobile = true;
    api.export.mockResolvedValue('/exports/diagnostics.zip');
    api.share.mockRejectedValueOnce(new Error('synthetic unrecognized failure'));
    click(render(), 'Exporter le diagnostic'); await settle();
    host.language = 'en';
    expect(renderToStaticMarkup(render())).toContain('Diagnostics were created, but sharing did not complete.');
    expect(api.export).toHaveBeenCalledTimes(2);
    expect(api.share).toHaveBeenCalledOnce();
  });

  it('traduit la confirmation de copie en cours sans recopier la référence', async () => {
    render(); await settle(); click(render(), 'Copier la référence'); await settle();
    host.language = 'en';
    expect(textOf(render())).toContain('Reference copied.');
    expect(textOf(render())).not.toContain('Référence copiée.');
    expect(api.clipboard).toHaveBeenCalledOnce();
  });

  it('partage le fichier exporté sur mobile et reprend le partage sans réexporter', async () => {
    api.mobile = true; api.share.mockRejectedValueOnce(new Error('network error'));
    render(); await settle(); click(render(), 'Exporter le diagnostic'); await settle();
    expect(api.export).toHaveBeenCalledOnce();
    expect(api.share).toHaveBeenCalledExactlyOnceWith('/exports/diagnostics.zip');
    const tree = render(); click(tree, 'Partager le diagnostic'); await settle();
    expect(api.export).toHaveBeenCalledOnce();
    expect(api.share).toHaveBeenCalledTimes(2);
    expect(textOf(render())).toContain('Diagnostic exporté.');
  });

  it.each([false, true])('garde l’export confirmé si seule la relecture échoue, mobile=%s', async mobile => {
    api.mobile = mobile;
    api.summary.mockResolvedValueOnce(summary).mockRejectedValueOnce(new Error('synthetic unrecognized failure'));
    render(); await settle(); click(render(), 'Exporter le diagnostic'); await settle();
    const tree = render();
    const guidance = children(tree).find(element => element.type === ErrorGuidance);
    expect(guidance).toBeDefined();
    expect(guidance!.props).toMatchObject({ operation: 'read', fallback: 'Le journal ne peut pas être lu pour le moment.' });
    expect(textOf(tree)).toContain('Diagnostic exporté.');
    expect(api.export).toHaveBeenCalledOnce();
    expect(api.share).toHaveBeenCalledTimes(mobile ? 1 : 0);
    api.summary.mockResolvedValue(summary);
    (guidance!.props as { onReload: () => void }).onReload(); await settle();
    expect(api.summary).toHaveBeenCalledTimes(3);
    expect(api.export).toHaveBeenCalledOnce();
    expect(api.share).toHaveBeenCalledTimes(mobile ? 1 : 0);
    expect(textOf(render())).toContain('Diagnostic exporté.');
  });

  it.each([
    ['fr', 'Diagnostic', 'Exporter le diagnostic', 'Effacer le journal', 'Effacer les événements de diagnostic ?'],
    ['de', 'Diagnose', 'Diagnose exportieren', 'Protokoll löschen', 'Diagnoseereignisse löschen?'],
    ['it', 'Diagnostica', 'Esporta diagnostica', 'Cancella registro', 'Cancellare gli eventi di diagnostica?'],
    ['en', 'Diagnostics', 'Export diagnostics', 'Clear log', 'Clear diagnostic events?'],
  ])('présente la lecture, l’export et la confirmation en %s', async (language, title, exporting, clear, confirmation) => {
    host.language = language as AppLanguage; render(); await settle();
    const tree = render();
    expect(children(tree).some(element => (element.props as {title?:string}).title === title)).toBe(true);
    expect(buttons(tree, exporting)).toHaveLength(1);
    click(tree, clear); expect(textOf(render())).toContain(confirmation);
    expect(api.clear).not.toHaveBeenCalled();
  });
});
