import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { AppLanguage } from './language';
type HookHost = { values: unknown[]; cursor: number; effects: Array<() => void>; cleanups: Map<number, () => void> };
const host = vi.hoisted(() => ({ current: { values: [], cursor: 0, effects: [], cleanups: new Map() } as HookHost, language: 'fr' as AppLanguage }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const instance = host.current, index = instance.cursor++; if (!(index in instance.values)) instance.values[index] = typeof initial === 'function' ? initial() : initial; return [instance.values[index], (next: unknown) => { instance.values[index] = typeof next === 'function' ? next(instance.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const instance = host.current, index = instance.cursor++; if (!(index in instance.values)) instance.values[index] = { current: initial }; return instance.values[index]; },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const instance = host.current, index = instance.cursor++, previous = instance.values[index] as unknown[] | undefined; if (!previous || deps.some((value, slot) => !Object.is(value, previous[slot]))) { instance.values[index] = deps; instance.effects.push(() => { instance.cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) instance.cleanups.set(index, cleanup); }); } },
}));
vi.mock('./language', () => ({ useAppLanguage: () => host.language, getAppLanguage: () => host.language, t: (text: string) => text }));
vi.mock('./ui', () => ({ Button: 'button', Modal: 'div' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
function instance(): HookHost { return { values: [], cursor: 0, effects: [], cleanups: new Map() }; }
function render(Component: ComponentType<any>, target: HookHost, props: object = {}) { host.current = target; target.cursor = 0; const tree = (Component as (props: any) => ReactNode)(props); for (const effect of target.effects.splice(0)) effect(); return tree; }
function elements(node: ReactNode): Array<ReactElement<any>> { if (Array.isArray(node)) return node.flatMap(elements); if (!node || typeof node !== 'object' || !('props' in node)) return []; const element = node as ReactElement<any>; return [element, ...elements(element.props.children)]; }
const settle = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };
function pending<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.resetModules(); host.current = instance(); host.language = 'fr'; });
afterEach(() => vi.unstubAllGlobals());
describe('deferred screen read diagnostics', () => {
  it.each([['fr', 'Cet écran n’a pas pu s’ouvrir.'], ['de', 'Dieser Bildschirm konnte nicht geöffnet werden.'], ['it', 'Questa schermata non ha potuto aprirsi.'], ['en', 'This screen could not be opened.']] as const)('shows stable safe read guidance in %s', async (language, title) => {
    host.language = language; const original = new Error('module interrupted password=private-secret alice@example.ch C:\\Users\\Alice\\private-document.pdf');
    const importer = vi.fn().mockRejectedValue(original), target = instance(), { deferView } = await import('./DeferredView'), { ErrorGuidance } = await import('./ErrorGuidance');
    const View = deferView(importer, { label: 'Ouverture du document…' }); render(View, target); await settle();
    const tree = render(View, target), guidance = elements(tree).find(element => element.type === ErrorGuidance);
    expect(guidance).toBeDefined(); expect(guidance!.props).toMatchObject({ error: original, operation: 'read', compact: true });
    const d = await import('./diagnostics'), events = d.recentDiagnosticEvents();
    expect(events.map(event => [event.operation, event.phase])).toEqual([['view.import.optional', 'start'], ['view.import.optional', 'failure']]);
    expect(guidance!.props.incidentCode).toBe(`ZT-${events[1].id}`);
    const html = renderToStaticMarkup(tree); expect(html).toContain(title); expect(html).toContain(guidance!.props.incidentCode);
    expect(html).not.toMatch(/private-secret|alice@example.ch|Alice|private-document.pdf/); expect(html).not.toContain('<details open');
    expect(elements(render(View, target)).find(element => element.type === ErrorGuidance)!.props.incidentCode).toBe(guidance!.props.incidentCode);
    expect(importer).toHaveBeenCalledOnce(); expect(JSON.stringify(events)).not.toMatch(/private-secret|password|alice@example|private-document|Alice/);
  });
  it.each(['resolve', 'reject'] as const)('shares an import and ignores an unmounted reader when it %s', async outcome => {
    const held = pending<{ default: () => ReactElement }>(), importer = vi.fn(() => held.promise), { deferView } = await import('./DeferredView');
    const View = deferView(importer, { label: 'Ouverture du document…' }), first = instance(), second = instance(), saved = vi.fn(), props = { saved, privateText: 'private-document' };
    render(View, first, props); render(View, second, props); await settle(); expect(importer).toHaveBeenCalledOnce();
    for (const cleanup of first.cleanups.values()) cleanup();
    const Screen = () => <p>Module prêt</p>; if (outcome === 'resolve') held.resolve({ default: Screen }); else held.reject(new Error('synthetic import interrupted'));
    await settle(); const d = await import('./diagnostics'); expect(d.recentDiagnosticEvents().map(event => event.phase)).toEqual(['start', outcome === 'resolve' ? 'success' : 'failure']);
    if (outcome === 'resolve') { const rendered = render(View, second, props) as ReactElement<any>; expect(rendered.type).toBe(Screen); expect(rendered.props).toEqual(props); }
    else { const { ErrorGuidance } = await import('./ErrorGuidance'); expect(elements(render(View, second, props)).some(element => element.type === ErrorGuidance)).toBe(true); }
    expect(first.values[0]).toBeUndefined(); expect(first.values[1]).toBeFalsy(); expect(saved).not.toHaveBeenCalled();
    expect(JSON.stringify(d.recentDiagnosticEvents())).not.toContain('private-document');
  });
  it('retries only module reading after an explicit click and preserves screen props', async () => {
    const saved = vi.fn(), Screen = () => <p>Module prêt</p>, importer = vi.fn().mockRejectedValueOnce(new Error('synthetic import interrupted')).mockResolvedValue({ default: Screen });
    const target = instance(), { deferView } = await import('./DeferredView'), View = deferView(importer, { label: 'Ouverture du document…' });
    render(View, target, { saved }); await settle(); const tree = render(View, target, { saved });
    expect(importer).toHaveBeenCalledOnce(); const button = elements(tree).find(element => element.type === 'button'); button!.props.onClick();
    render(View, target, { saved }); await settle(); const ready = render(View, target, { saved }) as ReactElement<any>;
    expect(ready.type).toBe(Screen); expect(ready.props.saved).toBe(saved); expect(saved).not.toHaveBeenCalled(); expect(importer).toHaveBeenCalledTimes(2);
    expect((await import('./diagnostics')).recentDiagnosticEvents().map(event => event.phase)).toEqual(['start', 'failure', 'start', 'success']);
  });
  it('keeps a visible read failure and stable incident even for an undefined rejection', async () => {
    const { deferView } = await import('./DeferredView'), { ErrorGuidance } = await import('./ErrorGuidance'), target = instance();
    const View = deferView(vi.fn().mockRejectedValue(undefined), { label: 'Ouverture du document…' }); render(View, target); await settle();
    const first = elements(render(View, target)).find(element => element.type === ErrorGuidance);
    expect(first).toBeDefined(); expect(first!.props.operation).toBe('read'); expect(first!.props.error).toBeUndefined(); expect(first!.props.incidentCode).toMatch(/^ZT-/);
    expect(elements(render(View, target)).find(element => element.type === ErrorGuidance)!.props.incidentCode).toBe(first!.props.incidentCode);
  });
  it.each(['ClientForm', 'StyledDocumentPreview', 'CloudBackupPanel', 'CatalogImportWizard'] as const)('identifies the fixed %s import without labels or props', async diagnosticName => {
    const { deferView } = await import('./DeferredView'), target = instance();
    const View = deferView(vi.fn().mockRejectedValue(new Error('synthetic import failure')), { label: 'private-document alice@example.ch', diagnosticName });
    render(View, target, { password: 'private-secret' }); await settle();
    const events = (await import('./diagnostics')).recentDiagnosticEvents();
    expect(events.map(event => event.operation)).toEqual([`view.import.${diagnosticName}`, `view.import.${diagnosticName}`]);
    expect(JSON.stringify(events)).not.toMatch(/private-document|alice@example|password|private-secret/);
  });
  it('rejects an arbitrary runtime diagnostic name without journaling it', async () => {
    const { deferView } = await import('./DeferredView'), target = instance();
    const View = deferView(vi.fn().mockRejectedValue(new Error('synthetic import failure')), { label: 'optional', diagnosticName: 'private-secret' as never });
    render(View, target); await settle();
    expect((await import('./diagnostics')).recentDiagnosticEvents().map(event => event.operation)).toEqual(['view.import.optional', 'view.import.optional']);
  });
  it('changes a modal loading label with the current language without reimporting or losing its close handler', async () => {
    const { deferView } = await import('./DeferredView'), target = instance(), held = pending<{ default: () => ReactElement }>();
    const importer = vi.fn(() => held.promise), close = vi.fn();
    const labels = {fr:'Ouverture du catalogue…',de:'Katalog wird geöffnet…',it:'Apertura del catalogo…',en:'Opening the catalogue…'};
    const View = deferView(importer,{label:labels,diagnosticName:'CatalogImportWizard',close:()=>close});
    for (const language of ['fr','de','it','en'] as const) {
      host.language=language;
      const tree=render(View,target) as ReactElement<any>;
      expect(tree.props.title).toBe(labels[language]);expect(tree.props.onClose).toBe(close);
      expect(elements(tree).find(element=>element.type==='section')!.props['aria-label']).toBe(labels[language]);
      expect(renderToStaticMarkup(tree)).toContain(labels[language]);await settle();
    }
    expect(importer).toHaveBeenCalledOnce();held.reject(new Error('synthetic import failure'));await settle();
    host.language='de';const failed=render(View,target) as ReactElement<any>;
    expect(failed.props.title).toBe(labels.de);expect(failed.props.onClose).toBe(close);expect(close).not.toHaveBeenCalled();
    expect((await import('./diagnostics')).recentDiagnosticEvents().map(event=>event.operation)).toEqual(['view.import.CatalogImportWizard','view.import.CatalogImportWizard']);
    const resumed=pending<{default:()=>ReactElement}>();importer.mockImplementationOnce(()=>resumed.promise);
    elements(failed).find(element=>element.type==='button')!.props.onClick();host.language='it';
    const retrying=render(View,target) as ReactElement<any>;expect(retrying.props.title).toBe(labels.it);expect(retrying.props.onClose).toBe(close);
    await settle();expect(importer).toHaveBeenCalledTimes(2);
    const Screen=()=> <p>Catalogue prêt</p>;resumed.resolve({default:Screen});await settle();
    expect((render(View,target) as ReactElement<any>).type).toBe(Screen);expect(close).not.toHaveBeenCalled();
    expect((await import('./diagnostics')).recentDiagnosticEvents().map(event=>event.phase)).toEqual(['start','failure','start','success']);
  });
});
