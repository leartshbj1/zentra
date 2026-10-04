import { afterEach, describe, expect, it, vi } from 'vitest';

// Real panel and diagnostics/intent wrappers; closed SDK and deferred document
// reader. Hook host makes layout and passive cleanup separate, deterministic phases.
const runtime = vi.hoisted(() => ({ host: null as any, read: vi.fn(), invoke: vi.fn(), company: null as any }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.state(...args), useRef: (...args: any[]) => runtime.host.ref(...args),
  useEffect: (action: any, deps: any) => runtime.host.effect(action, deps, 'passive'),
  useLayoutEffect: (action: any, deps: any) => runtime.host.effect(action, deps, 'layout'),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: runtime.invoke }));
vi.mock('./AutomationCompany', () => ({ useCompanyAutomation: () => runtime.company }));
vi.mock('./invoiceScan', async original => ({ ...await original<typeof import('./invoiceScan')>(), readInvoiceText: runtime.read }));
vi.mock('./ui', () => ({ Button: () => null, ErrorPanel: () => null }));
vi.mock('./language', () => ({ t: (value: string) => value, getAppLocale: () => 'fr-CH' }));
vi.mock('./TouchImagePreview', () => ({ TouchImagePreview: () => null }));
import { InvoiceScanPanel } from './InvoiceScanPanel';
import { Button, ErrorPanel } from './ui';
import type { InvoiceScan } from './invoiceScan';

type Element = { type: unknown; props: Record<string, any> };
type Props = Parameters<typeof InvoiceScanPanel>[0];
class Host {
  slots: any[] = []; index = 0; dirty = false; mounted = true; tree: unknown;
  effects: Array<{ phase: 'layout' | 'passive'; run: () => void }> = []; writes: unknown[] = []; unmountedWrites = 0;
  constructor(public component: (props: any) => unknown, public props: any) { this.render(); }
  state(initial: any) {
    const slot = this.slots[this.index++] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slot.value, (value: any) => { this.writes.push(value); if (!this.mounted) this.unmountedWrites++;
      const next = typeof value === 'function' ? value(slot.value) : value;
      if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true; }
    }];
  }
  ref(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
  effect(action: () => (() => void) | void, deps: unknown[], phase: 'layout' | 'passive') {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.effects.push({ phase, run: () => {
      previous?.cleanup?.(); this.slots[index] = { deps, phase, cleanup: action() };
    }});
  }
  render(props = this.props, commit = true) {
    this.props = props; this.index = 0; this.dirty = false; this.effects = []; runtime.host = this;
    this.tree = this.component(props);
    if (commit) { for (const phase of ['layout', 'passive']) for (const effect of this.effects) if (effect.phase === phase) effect.run(); this.flush(); }
  }
  flush() { if (this.mounted && this.dirty) this.render(); }
  unmount(layoutOnly = false) {
    for (const slot of this.slots) if (!layoutOnly || slot.phase === 'layout') slot.cleanup?.();
    this.mounted = false;
  }
}
function nodes(tree: unknown): Element[] {
  return Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Element, ...nodes((tree as Element).props?.children)];
}
function text(tree: unknown): string {
  return Array.isArray(tree) ? tree.map(text).join('') : !tree || typeof tree === 'boolean' ? '' : typeof tree === 'object' ? text((tree as Element).props?.children) : String(tree);
}
function one(host: Host, predicate: (element: Element) => boolean) { const matches = nodes(host.tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0]; }
const button = (host: Host, label: string) => one(host, node => node.type === Button && text(node).includes(label));
const message = (host: Host) => nodes(host.tree).find(node => node.type === ErrorPanel)?.props.message;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function settle(host?: Host) { for (let n = 0; n < 30; n++) { await Promise.resolve(); host?.flush(); } }
const file = new File(['SYNTHETIC'], 'synthetic.png', { type: 'image/png' });
const scannedText = 'SYNTHETIC SUPPLIER invoice 2026-10-01 CHF 108.10, wholly fictitious.';
const scan: InvoiceScan = { kind: 'supplier_invoice', supplierName: 'SYNTHETIC SUPPLIER', reference: 'SYNTHETIC-SCAN', invoiceDate: '2026-10-01', dueDate: '2026-10-31', currency: 'CHF', netCents: 10000, vatCents: 810, totalCents: 10810, vatBp: 810, issues: [], confidence: 1, evidence: {} };
function setup() {
  runtime.company = { organizationId: 'synthetic-org-a', readOnly: false, state: { active: true, available: ['supplier_routing'], settings: { enabled: true, consent: true, flags: ['supplier_routing'] } } };
  const reader = deferred<string>(), response = deferred<{ status: string; extraction?: InvoiceScan }>();
  runtime.read.mockImplementation(() => reader.promise);
  runtime.invoke.mockImplementation((command: string) => { if (command !== 'automation_request') throw Error(`Unapproved command ${command}`); return response.promise; });
  const onApply = vi.fn(), onBusy = vi.fn(), host = new Host(InvoiceScanPanel, { disabled: false, onApply, onBusy } satisfies Props);
  const choose = () => one(host, node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [file], value: 'synthetic' } });
  return { host, reader, response, onApply, onBusy, choose };
}
async function reachResponse(fixture: ReturnType<typeof setup>) { fixture.choose(); fixture.host.flush(); fixture.reader.resolve(scannedText); await settle(fixture.host); expect(runtime.invoke).toHaveBeenCalledTimes(1); }
async function ready(fixture: ReturnType<typeof setup>) { await reachResponse(fixture); fixture.response.resolve({ status: 'suggestion', extraction: scan }); await settle(fixture.host); }
afterEach(() => { runtime.read.mockReset(); runtime.invoke.mockReset(); runtime.company = null; runtime.host = null; vi.unstubAllGlobals(); });

describe('InvoiceScanPanel lifecycle', () => {
  it('keeps the current extraction, SDK payload and one deliberate draft application', async () => {
    const f = setup(); await ready(f);
    expect(runtime.invoke).toHaveBeenCalledWith('automation_request', expect.objectContaining({ data: { action: 'invoice_scan', requestId: expect.any(String), text: scannedText } }));
    button(f.host, 'Utiliser ces informations').props.onClick(); f.host.flush();
    expect(f.onApply).toHaveBeenCalledExactlyOnceWith(scan, file, scannedText); expect(text(f.host.tree)).not.toContain('Utiliser ces informations');
    expect(f.onBusy.mock.calls.at(-1)).toEqual([false]);
  });
  it('admits only one reader before the busy render', () => { const f = setup(); f.choose(); f.choose(); expect(runtime.read).toHaveBeenCalledTimes(1); });
  it('does not treat its own parent busy notification as a reason to cancel the accepted read', async () => {
    const f = setup(); f.choose(); f.host.render({ ...f.host.props, disabled: true }); f.reader.resolve(scannedText); await settle(f.host);
    expect(runtime.invoke).toHaveBeenCalledTimes(1); f.response.resolve({ status: 'suggestion', extraction: scan }); await settle(f.host);
    expect(button(f.host, 'Utiliser ces informations').props.disabled).toBe(true); expect(f.onBusy.mock.calls.at(-1)).toEqual([false]);
  });
  for (const layoutOnly of [false, true]) it(`does not dispatch after ${layoutOnly ? 'layout' : 'full'} unmount during reading`, async () => {
    const f = setup(); f.choose(); f.host.flush(); f.host.unmount(layoutOnly); const writes = f.host.writes.length;
    f.reader.resolve(scannedText); await settle(); expect(runtime.invoke).not.toHaveBeenCalled(); expect(f.onApply).not.toHaveBeenCalled(); expect(f.host.writes).toHaveLength(writes); expect(f.host.unmountedWrites).toBe(0);
  });
  for (const changed of ['readOnly', 'organization', 'inactive'] as const) it(`checks current ${changed} before SDK dispatch even before effects`, async () => {
    const f = setup(); f.choose(); f.host.flush();
    if (changed === 'readOnly') runtime.company = { ...runtime.company, readOnly: true };
    else if (changed === 'organization') runtime.company = { ...runtime.company, organizationId: 'synthetic-org-b' };
    else runtime.company = { ...runtime.company, state: null };
    f.host.render(f.host.props, false); f.reader.resolve(scannedText); await settle(); expect(runtime.invoke).not.toHaveBeenCalled(); expect(f.onApply).not.toHaveBeenCalled();
  });
  for (const changed of ['unmount', 'readOnly', 'organization', 'inactive'] as const) it(`does not publish the awaited extraction after ${changed}`, async () => {
    const f = setup(); await reachResponse(f);
    if (changed === 'unmount') f.host.unmount(true);
    else { runtime.company = { ...runtime.company, ...(changed === 'readOnly' ? { readOnly: true } : changed === 'organization' ? { organizationId: 'synthetic-org-b' } : { state: null }) }; f.host.render(); }
    const writes = f.host.writes.length; f.response.resolve({ status: 'suggestion', extraction: scan }); await settle(f.host);
    expect(f.host.writes).toHaveLength(writes); expect(f.onApply).not.toHaveBeenCalled(); expect(f.host.unmountedWrites).toBe(0);
  });
  it('does not publish late failures after layout unmount', async () => {
    const f = setup(); await reachResponse(f); f.host.unmount(true); const writes = f.host.writes.length;
    f.response.reject(Error('SYNTHETIC late refusal')); await settle(); expect(f.host.writes).toHaveLength(writes); expect(f.host.unmountedWrites).toBe(0);
  });
  it('preserves an in-scope refusal and releases busy for an explicit retry', async () => {
    const f = setup(); await reachResponse(f); f.response.reject(Error('SYNTHETIC current refusal')); await settle(f.host);
    expect(message(f.host)).toBe('SYNTHETIC current refusal'); expect(f.onBusy.mock.calls.at(-1)).toEqual([false]);
    runtime.read.mockResolvedValue(scannedText); runtime.invoke.mockResolvedValue({ status: 'suggestion', extraction: scan }); f.choose(); await settle(f.host);
    button(f.host, 'Utiliser ces informations').props.onClick(); expect(f.onApply).toHaveBeenCalledTimes(1); expect(runtime.invoke).toHaveBeenCalledTimes(2);
  });
  it('leaves the reader error intact and does not emit SDK work', async () => { const f = setup(); f.choose(); f.reader.reject(Error('SYNTHETIC unreadable file')); await settle(f.host); expect(message(f.host)).toBe('SYNTHETIC unreadable file'); expect(runtime.invoke).not.toHaveBeenCalled(); expect(f.onBusy.mock.calls.at(-1)).toEqual([false]); });
  it('consumes a suggestion before a second retained apply handler can run', async () => { const f = setup(); await ready(f); const apply = button(f.host, 'Utiliser ces informations').props.onClick; apply(); apply(); expect(f.onApply).toHaveBeenCalledTimes(1); });
  for (const changed of ['unmount', 'readOnly', 'organization', 'inactive', 'disabled'] as const) it(`refuses a retained apply handler after ${changed}`, async () => {
    const f = setup(); await ready(f); const apply = button(f.host, 'Utiliser ces informations').props.onClick;
    if (changed === 'unmount') f.host.unmount(true);
    else if (changed === 'disabled') f.host.render({ ...f.host.props, disabled: true });
    else { runtime.company = { ...runtime.company, ...(changed === 'readOnly' ? { readOnly: true } : changed === 'organization' ? { organizationId: 'synthetic-org-b' } : { state: null }) }; f.host.render(f.host.props, false); }
    const writes = f.host.writes.length; apply(); expect(f.onApply).not.toHaveBeenCalled(); expect(f.host.writes).toHaveLength(writes);
  });
  it('uses current callbacks and does not set state after apply synchronously unmounts', async () => {
    const f = setup(); await ready(f); const latest = vi.fn(() => f.host.unmount(true)); f.host.render({ ...f.host.props, onApply: latest });
    button(f.host, 'Utiliser ces informations').props.onClick(); expect(latest).toHaveBeenCalledExactlyOnceWith(scan, file, scannedText); expect(f.onApply).not.toHaveBeenCalled(); expect(f.host.unmountedWrites).toBe(0);
  });
  it('uses the current busy callback when an accepted read finishes', async () => {
    const f = setup(); f.choose(); const latest = vi.fn(); f.host.render({ ...f.host.props, onBusy: latest }); f.reader.resolve(scannedText); await settle(f.host);
    f.response.resolve({ status: 'suggestion', extraction: scan }); await settle(f.host); expect(latest.mock.calls.at(-1)).toEqual([false]); expect(f.onBusy.mock.calls.at(-1)).toEqual([true]);
  });
  it('consumes a dismissed suggestion before any retained apply handler', async () => {
    const f = setup(); await ready(f); const apply = button(f.host, 'Utiliser ces informations').props.onClick;
    one(f.host, node => node.type === Button && node.props['aria-label'] === 'Fermer la proposition').props.onClick(); apply(); f.host.flush();
    expect(f.onApply).not.toHaveBeenCalled(); expect(text(f.host.tree)).not.toContain('Utiliser ces informations');
  });
  it('does not publish a retained dismissal after layout unmount', async () => {
    const f = setup(); await ready(f); const dismiss = one(f.host, node => node.type === Button && node.props['aria-label'] === 'Fermer la proposition').props.onClick;
    f.host.unmount(true); const writes = f.host.writes.length; dismiss(); expect(f.host.writes).toHaveLength(writes); expect(f.host.unmountedWrites).toBe(0);
  });
  it('checks lifetime after the busy callback without starting an orphaned reader', () => {
    const f = setup(); f.host.render({ ...f.host.props, onBusy: (busy: boolean) => { if (busy) f.host.unmount(true); } }); f.choose();
    expect(runtime.read).not.toHaveBeenCalled(); expect(f.host.unmountedWrites).toBe(0);
  });
  it('ignores reader progress after layout unmount', () => {
    const f = setup(); f.choose(); f.host.flush(); const progress = runtime.read.mock.calls[0][1]; f.host.unmount(true);
    const writes = f.host.writes.length; progress('SYNTHETIC late progress'); expect(f.host.writes).toHaveLength(writes); expect(f.host.unmountedWrites).toBe(0);
  });
  it('releases busy on readOnly and admits a deliberate new read after permission returns', async () => {
    const f = setup(); f.choose(); f.host.flush(); runtime.company = { ...runtime.company, readOnly: true }; f.host.render();
    expect(f.onBusy.mock.calls.at(-1)).toEqual([false]); expect(button(f.host, 'Scanner une facture').props.disabled).toBe(true);
    f.reader.resolve(scannedText); await settle(f.host); expect(runtime.invoke).not.toHaveBeenCalled();
    runtime.company = { ...runtime.company, readOnly: false }; f.host.render(); runtime.read.mockResolvedValue(scannedText);
    runtime.invoke.mockResolvedValue({ status: 'suggestion', extraction: scan }); f.choose(); await settle(f.host);
    expect(runtime.invoke).toHaveBeenCalledTimes(1); button(f.host, 'Utiliser ces informations').props.onClick(); expect(f.onApply).toHaveBeenCalledTimes(1);
  });
  for (const invalid of [{ kind: 'other' as const }, { currency: 'EUR' }]) it(`keeps ${JSON.stringify(invalid)} suggestions non-applicable`, async () => {
    const f = setup(); await reachResponse(f); f.response.resolve({ status: 'suggestion', extraction: { ...scan, ...invalid } }); await settle(f.host);
    const apply = button(f.host, 'Utiliser ces informations'); expect(apply.props.disabled).toBe(true); apply.props.onClick(); expect(f.onApply).not.toHaveBeenCalled();
  });
  it('rejects a retained reader after readOnly or disabled changed without starting work', () => {
    const f = setup(), choose = one(f.host, node => node.type === 'input').props.onChange; runtime.company = { ...runtime.company, readOnly: true }; f.host.render();
    choose({ target: { files: [file], value: 'synthetic' } }); expect(runtime.read).not.toHaveBeenCalled();
    runtime.company = { ...runtime.company, readOnly: false }; f.host.render({ ...f.host.props, disabled: true }); choose({ target: { files: [file], value: 'synthetic' } }); expect(runtime.read).not.toHaveBeenCalled();
  });
  it('revokes original URLs and blocks pending original state at layout cleanup', async () => {
    const f = setup(); await ready(f); const original = one(f.host, node => typeof node.type === 'function' && (node.type as Function).name === 'Original');
    const buffer = deferred<ArrayBuffer>(), imageFile = { name: 'synthetic.png', arrayBuffer: () => buffer.promise }; const create = vi.fn(() => 'blob:synthetic-original'), revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const child = new Host(original.type as (props: any) => unknown, { ...original.props, file: imageFile }); child.unmount(true); const writes = child.writes.length;
    buffer.resolve(new ArrayBuffer(8)); await settle(); expect(create).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:synthetic-original'); expect(child.writes).toHaveLength(writes); expect(child.unmountedWrites).toBe(0);
  });
});


import { recentDiagnosticEvents, knownErrorIncident } from './diagnostics';
const scanLogIds = () => new Set(recentDiagnosticEvents().map(event => event.id));
const newScanEvents = (before: Set<string>) => recentDiagnosticEvents().filter(event => !before.has(event.id));
describe('invoice scan preparation diagnostic boundary', () => {
  it('traces a local reader failure before analysis, retains its incident and sends no SDK request', async () => {
    const f=setup(), before=scanLogIds(), original=Error('PRIVATE_SYNTHETIC OCR supplier@example.invalid amount=108.10 token=NOT-A-SECRET');
    f.choose(); f.reader.reject(original); await settle(f.host);
    const events=newScanEvents(before);
    expect(events.map(event=>[event.operation,event.phase])).toEqual([['invoice.scan_preprocess','start'],['invoice.scan_preprocess','failure']]);
    expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(knownErrorIncident(original)?.code).toBe(`ZT-${events[1].id}`);
    expect(message(f.host)).toBe(original.message); expect(runtime.invoke).not.toHaveBeenCalled();
    expect(runtime.read).toHaveBeenCalledTimes(1); expect(f.onBusy.mock.calls.at(-1)).toEqual([false]);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_SYNTHETIC|supplier@example|108\.10|NOT-A-SECRET|synthetic\.png/);
  });
  it('measures successful local preparation while preserving the single native payload and suggestion', async () => {
    const f=setup(), before=scanLogIds(); await ready(f);
    const events=newScanEvents(before), local=events.filter(event=>event.operation==='invoice.scan_preprocess');
    expect(local.map(event=>event.phase)).toEqual(['start','success']); expect(local[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(events.filter(event=>event.operation==='automation.invoice_scan').map(event=>event.phase)).toEqual(['start','success']);
    expect(runtime.invoke).toHaveBeenCalledExactlyOnceWith('automation_request', expect.objectContaining({data:{action:'invoice_scan',requestId:expect.any(String),text:scannedText}}));
    button(f.host,'Utiliser ces informations').props.onClick(); expect(f.onApply).toHaveBeenCalledExactlyOnceWith(scan,file,scannedText);
    expect(JSON.stringify(events)).not.toMatch(/SYNTHETIC SUPPLIER|SYNTHETIC-SCAN|synthetic-org|synthetic\.png/);
  });
  it('does not start even the diagnostic read after the busy callback unmounts the panel', () => {
    const f=setup(), before=scanLogIds(); f.host.render({...f.host.props,onBusy:(busy:boolean)=>{if(busy)f.host.unmount(true);}}); f.choose();
    expect(runtime.read).not.toHaveBeenCalled(); expect(runtime.invoke).not.toHaveBeenCalled();
    expect(newScanEvents(before)).toEqual([]); expect(f.host.unmountedWrites).toBe(0);
  });
});
