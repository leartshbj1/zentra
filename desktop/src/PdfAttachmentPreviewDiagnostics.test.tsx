import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Source-relative candidate test. No React DOM, browser, native IPC or PDF worker.
const runtime = vi.hoisted(() => ({ host: null as any, getDocument: vi.fn(), invoke: vi.fn(), guidance: vi.fn(() => null), touchZoom: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.state(...args),
  useRef: (...args: any[]) => runtime.host.ref(...args),
  useEffect: (...args: any[]) => runtime.host.effect(...args),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: runtime.invoke }));
vi.mock('./pdfRuntime', () => ({ getDocument: runtime.getDocument }));
vi.mock('./language', () => ({ t: (value: string) => value, useAppLanguage: () => 'fr' }));
vi.mock('./useTouchZoom', () => ({ useTouchZoom: runtime.touchZoom }));
vi.mock('./ui', () => ({ Button: () => null }));
vi.mock('./ErrorGuidance', () => ({ ErrorGuidance: runtime.guidance }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function walk(node: any, visit: (node: any) => void) {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return; }
  if (!node || typeof node !== 'object' || !node.props) return;
  visit(node); walk(node.props.children, visit);
}
class Host {
  slots: any[] = []; index = 0; effects: Array<() => void> = [];
  mounted = true; dirty = false; unmountedWrites = 0; tree!: ReactElement;
  viewport = { clientWidth: 332, focus: vi.fn(), scrollTo: vi.fn() };
  surface = { replaceChildren: vi.fn() };
  constructor(public component: (props: any) => ReactElement, public props: any) { this.render(); }
  state(initial: unknown) {
    const slot = this.slots[this.index++] ??= { value: initial };
    return [slot.value, (value: any) => {
      if (!this.mounted) this.unmountedWrites++;
      const next = typeof value === 'function' ? value(slot.value) : value;
      if (!Object.is(slot.value, next)) { slot.value = next; this.dirty = true; }
    }];
  }
  ref(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
  effect(action: () => (() => void) | void, deps: unknown[]) {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.effects.push(() => {
      previous?.cleanup?.(); this.slots[index] = { deps, cleanup: action() };
    });
  }
  render(props = this.props) {
    this.props = props; this.index = 0; this.effects = []; this.dirty = false; runtime.host = this;
    this.tree = this.component(props);
    walk(this.tree, node => { if (node.props.ref) node.props.ref.current = node.props.className === 'pdf-attachment-preview__viewport' ? this.viewport : this.surface; });
    for (const effect of this.effects) effect();
  }
  flush() { for (let n = 0; n < 20 && this.mounted && this.dirty; n++) this.render(); }
  guidance() { let result: any; walk(this.tree, node => { if (node.type === runtime.guidance) result = node.props; }); return result; }
  unmount() { this.mounted = false; for (const slot of this.slots) slot.cleanup?.(); }
}
async function settle(host: Host) { for (let n = 0; n < 30; n++) { await Promise.resolve(); host.flush(); } }
function fixture() {
  const load = deferred<any>(), rendered = deferred<void>();
  const cancelReason = Object.assign(new Error('private cancellation'), { name: 'RenderingCancelledException' });
  const renderTask = { promise: rendered.promise, cancel: vi.fn(() => rendered.reject(cancelReason)) };
  const page = {
    getViewport: vi.fn(({ scale }) => ({ width: 300 * scale, height: 240 * scale })),
    render: vi.fn(() => renderTask), getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'private-document-text', hasEOL: true }] }), cleanup: vi.fn(),
  };
  const pdf = { numPages: 2, getPage: vi.fn().mockResolvedValue(page) };
  const task = { promise: load.promise, destroy: vi.fn().mockResolvedValue(undefined) };
  return { load, rendered, renderTask, page, pdf, task };
}
const bytes = new Uint8Array([9, 8, 7]);
const mountedHosts: Host[] = [];
async function mount() {
  const component = (await import('./PdfAttachmentPreview')).default;
  const host = new Host(component, { bytes, name: 'private-original.pdf' }); mountedHosts.push(host); await settle(host); return host;
}
function assertPrivate(events: readonly unknown[]) { expect(JSON.stringify(events)).not.toMatch(/private-|original\.pdf|document-text|customer@example|token|bytes|name|message/); }
beforeEach(() => {
  vi.resetModules(); runtime.getDocument.mockReset(); runtime.invoke.mockReset(); runtime.guidance.mockClear(); runtime.touchZoom.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ({}), setAttribute: vi.fn(), remove: vi.fn() }) };
  vi.stubGlobal('document', document); vi.stubGlobal('window', { document });
});
afterEach(async () => { for (const host of mountedHosts.splice(0)) if (host.mounted) { host.unmount(); await settle(host); } vi.unstubAllGlobals(); });

describe('attachment reader private diagnostics', () => {
  it.each(['throw', 'reject'] as const)('records a %s load failure and presents its original incident', async stage => {
    const f = fixture(), original = new Error('Invalid PDF private-original.pdf token=private-secret');
    if (stage === 'throw') runtime.getDocument.mockImplementation(() => { throw original; });
    else runtime.getDocument.mockReturnValue(f.task);
    const host = await mount(); if (stage === 'reject') { f.load.reject(original); await settle(host); }
    const d = await import('./diagnostics'), events = d.recentDiagnosticEvents();
    expect(events.map(event => [event.operation, event.phase])).toEqual([['pdf.attachment_load', 'start'], ['pdf.attachment_load', 'failure']]);
    expect(events[1].id).toBe(events[0].id); expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(d.resolveErrorIncident(original).code).toBe(`ZT-${events[1].id}`);
    expect(host.guidance()).toMatchObject({ title: 'Aperçu indisponible', error: 'Ce PDF ne peut pas être affiché. Réessayez, ou ouvrez-le avec une application compatible.', incidentCode: `ZT-${events[1].id}`, operation: 'read' });
    expect(d.recentDiagnosticEvents()).toHaveLength(2); assertPrivate(events);
  });

  it('retains the protected PDF message and disables retry without replacing its incident', async () => {
    const f = fixture(), original = Object.assign(new Error('private password'), { name: 'PasswordException' });
    runtime.getDocument.mockReturnValue(f.task);
    const host = await mount(); f.load.reject(original); await settle(host);
    const d = await import('./diagnostics');
    expect(host.guidance()).toMatchObject({ error: 'Ce PDF est protégé par un mot de passe. Ouvrez-le avec une application compatible.', operation: 'mutation', onReload: undefined, incidentCode: d.resolveErrorIncident(original).code });
    assertPrivate(d.recentDiagnosticEvents());
  });

  it('keeps successful rendering, input bytes, zoom and optional text-layer failure while tracing cleanup', async () => {
    const f = fixture(); f.page.getTextContent.mockRejectedValue(new Error('private-text-layer')); runtime.getDocument.mockReturnValue(f.task);
    const host = await mount(); f.load.resolve(f.pdf); f.rendered.resolve(); await settle(host);
    expect(f.page.render).toHaveBeenCalledOnce(); expect(f.page.cleanup).toHaveBeenCalledOnce(); expect(host.guidance()).toBeUndefined();
    expect(runtime.touchZoom).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 1, expect.any(Function), true, 1, 4);
    expect(bytes).toEqual(new Uint8Array([9, 8, 7])); expect(runtime.getDocument.mock.calls[0][0].data).not.toBe(bytes);
    host.unmount(); await settle(host);
    const d = await import('./diagnostics'), events = d.recentDiagnosticEvents();
    expect(events).toHaveLength(6);
    for (const operation of ['pdf.attachment_load', 'pdf.attachment_render', 'pdf.attachment_cleanup']) {
      const pair = events.filter(event => event.operation === operation);
      expect(pair.map(event => event.phase)).toEqual(['start', 'success']);
      expect(pair[1].id).toBe(pair[0].id); expect(pair[1].durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(f.task.destroy).toHaveBeenCalledExactlyOnceWith(); expect(host.unmountedWrites).toBe(0); assertPrivate(events);
  });

  it('preserves a render failure incident and records failed destruction separately', async () => {
    const f = fixture(), original = new Error('private rendering failure customer@example.invalid'); runtime.getDocument.mockReturnValue(f.task);
    const host = await mount(); f.load.resolve(f.pdf); await settle(host); f.rendered.reject(original); await settle(host);
    const d = await import('./diagnostics'), renderFailure = d.recentDiagnosticEvents().find(event => event.operation === 'pdf.attachment_render' && event.phase === 'failure')!;
    expect(host.guidance().incidentCode).toBe(`ZT-${renderFailure.id}`); expect(d.resolveErrorIncident(original).code).toBe(`ZT-${renderFailure.id}`);
    f.task.destroy.mockRejectedValue(new Error('disk full private-original.pdf token=private-secret')); host.unmount(); await settle(host);
    expect(d.recentDiagnosticEvents().at(-1)).toMatchObject({ operation: 'pdf.attachment_cleanup', phase: 'failure', errorCode: 'STORAGE' });
    expect(f.task.destroy).toHaveBeenCalledOnce(); expect(host.unmountedWrites).toBe(0); assertPrivate(d.recentDiagnosticEvents());
  });

  it('does not invent a load incident when closing or replacing an unfinished document', async () => {
    const first = fixture(), second = fixture(); runtime.getDocument.mockReturnValueOnce(first.task).mockReturnValueOnce(second.task);
    const host = await mount(); host.render({ bytes: new Uint8Array([6, 5, 4]), name: 'private-replacement.pdf' }); await settle(host);
    first.load.reject(new Error('Worker was destroyed for private-original.pdf')); await settle(host);
    expect(host.guidance()).toBeUndefined(); expect(first.task.destroy).toHaveBeenCalledOnce(); expect(first.pdf.getPage).not.toHaveBeenCalled();
    host.unmount(); second.load.reject(new Error('private superseded load')); await settle(host);
    const d = await import('./diagnostics'); expect(d.recentDiagnosticEvents().some(event => event.phase === 'failure')).toBe(false);
    expect(host.unmountedWrites).toBe(0); assertPrivate(d.recentDiagnosticEvents());
  });

  it('does not turn normal render or teardown cancellation into an incident', async () => {
    const f = fixture(); runtime.getDocument.mockReturnValue(f.task);
    const host = await mount(); f.load.resolve(f.pdf); await settle(host);
    f.task.destroy.mockRejectedValue(Object.assign(new Error('private worker cancellation'), { name: 'AbortException' }));
    host.unmount(); await settle(host);
    expect(f.renderTask.cancel).toHaveBeenCalledOnce(); expect(f.page.cleanup).toHaveBeenCalledOnce();
    const d = await import('./diagnostics'); expect(d.recentDiagnosticEvents().some(event => event.phase === 'failure')).toBe(false);
    expect(host.unmountedWrites).toBe(0); assertPrivate(d.recentDiagnosticEvents());
  });
});
