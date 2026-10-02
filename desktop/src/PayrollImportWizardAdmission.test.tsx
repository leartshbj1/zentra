import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Actual Wizard, actual bridge and actual provider. Only hooks,
// document transforms, IPC and the Worker transport are controlled/synthetic.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn(), prepare: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: runtime.invoke }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
 useRef: (initial: unknown) => runtime.host.ref(initial),
 useState: (initial: unknown) => runtime.host.state(initial),
 useMemo: (factory: () => unknown, deps: unknown[]) => runtime.host.memo(factory, deps),
 useEffect: (setup: () => unknown, deps: unknown[]) => runtime.host.effect(setup, deps),
  useLayoutEffect: (setup: () => unknown, deps: unknown[]) => runtime.host.effect(setup, deps, true),
}));
vi.mock('./language', () => ({ t: (text: string) => text, useAppLanguage: () => 'fr', getAppLocale: () => 'fr-CH' }));
vi.mock('./ui', () => ({ Button: () => null, Field: () => null, Modal: () => null, ErrorPanel: () => null }));
vi.mock('./localPdfPreview', () => ({ prepareImageForAnalysis: runtime.prepare, renderPdfPages: vi.fn() }));
vi.mock('./payrollPdfText', () => ({ extractPayrollPdfTextByPage: vi.fn() }));
class ControlledWorker {
 static instances: ControlledWorker[] = [];
 terminated = false; messages: Array<Record<string, unknown>> = [];
 listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
 constructor() { ControlledWorker.instances.push(this); }
 addEventListener(type: string, callback: (event: { data?: unknown }) => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
 postMessage(message: Record<string, unknown>) { this.messages.push(message); }
 terminate() { this.terminated = true; }
 emit(data: unknown) { for (const listener of this.listeners.get('message') || []) listener({ data }); }
}
class Host {
 slots: any[] = []; index = 0; effects: Array<() => void> = []; tree: any;
 mounted = true; dirty = false; unmountedWrites = 0; close = vi.fn(() => this.unmount()); act = vi.fn();
 constructor(public component: (props: any) => unknown, public workspace: any) { this.render(); }
 ref(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
 state(initial: any) {
  const slot = this.slots[this.index++] ??= { value: typeof initial === 'function' ? initial() : initial };
  return [slot.value, (value: any) => {
   if (!this.mounted) this.unmountedWrites++;
   const next = typeof value === 'function' ? value(slot.value) : value;
   if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true; }
  }];
 }
 memo(factory: () => unknown, deps: unknown[]) {
  const index = this.index++, previous = this.slots[index];
  if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.slots[index] = { deps, value: factory() };
  return this.slots[index].value;
 }
  effect(setup: () => unknown, deps: unknown[], layout = false) {
  const index = this.index++, previous = this.slots[index];
  if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.effects.push(() => {
    previous?.cleanup?.(); this.slots[index] = { deps, setup, layout, cleanup: setup() };
  });
 }
 render() {
  this.index = 0; this.effects = []; this.dirty = false; runtime.host = this;
  this.tree = this.component({ workspace: this.workspace, close: this.close, act: this.act });
  for (const effect of this.effects) effect();
 }
 flush() { if (this.mounted && this.dirty) this.render(); }
 unmount() { for (const slot of this.slots) slot.cleanup?.(); this.mounted = false; }
  detachBeforePassiveCleanup() { for (const slot of this.slots) if (slot.layout) slot.cleanup?.(); this.mounted = false; }
  finishPassiveCleanup() { for (const slot of this.slots) if (!slot.layout) slot.cleanup?.(); }
 replayEffects() { for (const slot of this.slots) if (slot.setup) { slot.cleanup?.(); slot.cleanup = slot.setup(); } }
}
type Element = { type?: unknown; props?: Record<string, any> };
function nodes(tree: unknown): Element[] { return Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Element, ...nodes((tree as Element).props?.children)]; }
function text(tree: unknown): string { return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text((tree as Element).props?.children) : ''; }
function click(host: Host, label: string) {
 const choices = nodes(host.tree).filter(value => value.props?.onClick && text(value.props?.children).includes(label));
 expect(choices).toHaveLength(1); choices[0].props!.onClick(); host.flush();
}
function activeImport() {
 const draft = { employee: { employeeNumber: '', name: 'Synthetic employee', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly' }, period: '2026-09', paymentDate: '2026-09-25', grossCents: 500000, netCents: 500000, lines: [{ id: 'synthetic-line', label: 'Synthetic wage', kind: 'earning', amountCents: 500000, recurring: false, confidenceBp: 10000 }], warnings: [] };
 return { id: 'synthetic-import', status: 'needs_review', mediaKind: 'image', sourceName: 'synthetic.png', extractionEngine: 'manual_review', extractedText: 'Synthetic salary text '.repeat(15), fileSha256: 'a'.repeat(64), fileSize: 128, analysisManifest: null, draft };
}
const hosts: Host[] = [];
const ai = async () => (await import('./payrollLocalAi')).payrollLocalAi;
async function wizard(active: boolean | number = false) {
 const { PayrollImportWizard } = await import('./PayrollImportWizard');
 const current = new Host(PayrollImportWizard, { payrollImports: active ? Array.from({ length: typeof active === 'number' ? active : 1 }, (_, index) => ({ ...activeImport(), id: `synthetic-import-${index}` })) : [], employees: [], employeePayrollTemplates: [] });
 hosts.push(current); return current;
}
async function assistant() {
 const provider = await ai(); let outcome = 'pending';
 const task = provider.chat({ question: 'Synthetic help', screen: 'Paie', facts: {}, history: [] }, () => {}).then(() => { outcome = 'success'; }, () => { outcome = 'rejected'; });
 const worker = ControlledWorker.instances.at(-1)!;
 return { provider, worker, task, outcome: () => outcome, finish() { worker.emit({ type: 'assistant_result', requestId: worker.messages[0].requestId, output: 'Synthetic answer' }); } };
}
async function settle(host?: Host) { for (let n = 0; n < 40; n++) { await Promise.resolve(); host?.flush(); } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function result(worker: ControlledWorker) {
  const request = worker.messages.filter(value => value.type === 'analyze').at(-1)!;
 worker.emit({ type: 'analysis', requestId: request.requestId, mode: 'wasm', primaryOutput: JSON.stringify({ employee_name: 'Synthetic employee', gross_cents: 500000, net_cents: 500000, period: '2026-09', payment_date: '2026-09-25', source_page: 1, lines: [['Synthetic wage', 'earning', 500000]], warnings: [] }), verifiedOutput: '' });
}
function savedRow(input: any) {
 return { id: input.id, media_kind: 'image', source_name: 'synthetic.png', file_sha256: 'a'.repeat(64), file_size: 128, extraction_engine: input.extraction_engine, engine_version: input.engine_version, confidence_bp: input.confidence_bp, draft_json: JSON.stringify(input.draft), analysis_manifest_json: JSON.stringify(input.analysis_manifest), status: 'needs_review' };
}
async function admitted(component: Host, queue = false) {
 click(component, queue ? 'Analyser la file' : 'Analyser avec l’IA locale');
 await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1)); const worker = ControlledWorker.instances[0];
 expect(worker.messages[0].type).toBe('check'); worker.emit({ type: 'check', mode: 'wasm' });
 await vi.waitFor(() => { component.flush(); expect(worker.messages.at(-1)?.type).toBe('analyze'); }); return worker;
}
beforeEach(() => {
 vi.resetModules(); ControlledWorker.instances = []; hosts.length = 0; runtime.host = null; runtime.invoke.mockReset();
 runtime.prepare.mockReset(); runtime.prepare.mockResolvedValue('data:image/png;base64,U3ludGhldGlj');
 runtime.invoke.mockImplementation((command: string) => {
  if (command === 'get_payroll_document_preview') return Promise.resolve({ mime_type: 'image/png', data_base64: 'U3ludGhldGlj' });
  throw Error(`Blocked unexpected synthetic transport: ${command}`);
 });
 vi.stubGlobal('Worker', ControlledWorker); vi.stubGlobal('window', { atob: globalThis.atob });
});
afterEach(async () => { for (const host of hosts) if (host.mounted) host.unmount(); (await ai()).cancel(); runtime.prepare.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('payroll Wizard owns only its admitted local analysis', () => {
 it('provider busy refusal control keeps the existing assistant pending', async () => {
  const current = await assistant(); await expect(current.provider.analyze({ extractedText: 'Synthetic text' })).rejects.toThrow('déjà utilisé');
  expect(current.worker.terminated).toBe(false); expect(current.outcome()).toBe('pending'); current.finish(); await current.task;
 });
 it('closing an idle Wizard should not cancel an assistant the Wizard never admitted', async () => {
  const current = await assistant(), component = await wizard();
  expect(current.worker.messages.map(value => value.type)).toEqual(['assistant_chat']); expect(runtime.invoke).not.toHaveBeenCalled();
  component.tree.props.onClose(); await settle(component); expect(component.close).toHaveBeenCalledOnce();
  expect(current.worker.terminated).toBe(false); expect(current.outcome()).toBe('pending'); current.finish(); await current.task;
 });
 it('idle StrictMode-style effect replay should not cancel the existing assistant', async () => {
  const current = await assistant(), component = await wizard(); component.replayEffects(); await settle(component);
  expect(current.worker.messages.map(value => value.type)).toEqual(['assistant_chat']); expect(current.worker.terminated).toBe(false);
  current.finish(); await current.task;
 });
 it('a busy analyze refusal leaves the assistant pending until idle-Wizard closure should preserve it', async () => {
  const current = await assistant(), component = await wizard(true); await settle(component);
  click(component, 'Analyser avec l’IA locale'); await vi.waitFor(() => expect(current.worker.messages.at(-1)?.type).toBe('check'));
  current.worker.emit({ type: 'check', mode: 'wasm' });
  await vi.waitFor(() => { component.flush(); expect(nodes(component.tree).some(value => String(value.props?.message).includes('déjà utilisé'))).toBe(true); });
  expect(current.worker.messages.map(value => value.type)).toEqual(['assistant_chat', 'check']); expect(current.worker.terminated).toBe(false); expect(current.outcome()).toBe('pending');
  component.tree.props.onClose(); await settle(component); expect(component.close).toHaveBeenCalledOnce();
  expect(current.worker.terminated).toBe(false); current.finish(); await current.task;
 });
 it('cancelling only a capability check should preserve another admitted assistant', async () => {
  const current = await assistant(), component = await wizard(true); await settle(component);
  click(component, 'Analyser avec l’IA locale'); await vi.waitFor(() => expect(current.worker.messages.at(-1)?.type).toBe('check'));
  component.flush(); click(component, 'Annuler l’analyse'); await settle(component);
  expect(current.worker.messages.map(value => value.type)).toEqual(['assistant_chat', 'check']);
  expect(current.worker.terminated).toBe(false); expect(current.outcome()).toBe('pending'); current.finish(); await current.task;
 });
 it('control: explicit cancel stops an analysis really admitted by this Wizard', async () => {
  const provider = await ai(), component = await wizard(true); await settle(component); click(component, 'Analyser avec l’IA locale');
  await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1)); const worker = ControlledWorker.instances[0];
  expect(worker.messages[0].type).toBe('check'); worker.emit({ type: 'check', mode: 'wasm' });
  await vi.waitFor(() => { component.flush(); expect(worker.messages.at(-1)?.type).toBe('analyze'); });
  expect(provider.isBusy()).toBe(true); click(component, 'Annuler l’analyse'); await settle(component);
  expect(worker.terminated).toBe(true); expect(provider.isBusy()).toBe(false); expect(component.act).not.toHaveBeenCalled();
  expect(runtime.invoke.mock.calls.every(([command]) => command === 'get_payroll_document_preview')).toBe(true);
 });
 it('control: unmount stops its own admitted analysis without persisting an incomplete draft', async () => {
  const provider = await ai(), component = await wizard(true); await settle(component); click(component, 'Analyser avec l’IA locale');
  await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1)); const worker = ControlledWorker.instances[0];
  worker.emit({ type: 'check', mode: 'wasm' }); await vi.waitFor(() => expect(worker.messages.at(-1)?.type).toBe('analyze'));
  component.unmount(); await settle(component); expect(worker.terminated).toBe(true); expect(provider.isBusy()).toBe(false);
  expect(component.act).not.toHaveBeenCalled(); expect(runtime.invoke.mock.calls.every(([command]) => command === 'get_payroll_document_preview')).toBe(true);
 });
 it('a fresh owned analysis can be admitted and cancelled after StrictMode-style effect replay', async () => {
  const provider = await ai(), component = await wizard(true); await settle(component); component.replayEffects();
  const worker = await admitted(component); expect(provider.isBusy()).toBe(true);
  click(component, 'Annuler l’analyse'); await settle(component); expect(worker.terminated).toBe(true); expect(provider.isBusy()).toBe(false);
 });
 it('closing an idle Wizard preserves another pending capability check', async () => {
  const provider = await ai(); let outcome = 'pending';
  const task = provider.check().then(mode => { outcome = mode; }); const worker = ControlledWorker.instances[0];
  const component = await wizard(); component.tree.props.onClose(); await settle(component);
  expect(worker.terminated).toBe(false); expect(outcome).toBe('pending');
  worker.emit({ type: 'check', mode: 'wasm' }); await task; expect(outcome).toBe('wasm');
 });
 it('a check reply after unmount cannot start an analysis or publish late setters', async () => {
  const component = await wizard(true); await settle(component); click(component, 'Analyser avec l’IA locale');
  await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1)); const worker = ControlledWorker.instances[0];
  component.unmount(); worker.emit({ type: 'check', mode: 'wasm' }); await settle(component);
  expect(ControlledWorker.instances.flatMap(value => value.messages).filter(value => value.type === 'analyze')).toHaveLength(0);
  expect(component.unmountedWrites).toBe(0); expect(runtime.invoke.mock.calls.every(([command]) => command === 'get_payroll_document_preview')).toBe(true);
 });
 it('image preparation resolving after unmount cannot admit a new analysis or save a draft', async () => {
  const opening = deferred<string>(); runtime.prepare.mockReturnValueOnce(opening.promise);
  const component = await wizard(true); await settle(component); click(component, 'Analyser avec l’IA locale');
  await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1)); const worker = ControlledWorker.instances[0]; worker.emit({ type: 'check', mode: 'wasm' });
  await vi.waitFor(() => expect(runtime.prepare).toHaveBeenCalledOnce()); component.unmount();
  opening.resolve('data:image/png;base64,U3ludGhldGlj'); await settle(component);
  expect(ControlledWorker.instances.flatMap(value => value.messages).filter(value => value.type === 'analyze')).toHaveLength(0);
  expect(component.unmountedWrites).toBe(0); expect(runtime.invoke.mock.calls.every(([command]) => command === 'get_payroll_document_preview')).toBe(true);
 });
 it('keeps a normal completed draft save once, its progress and the warm worker', async () => {
  runtime.invoke.mockImplementation((command: string, args: any) => command === 'get_payroll_document_preview' ? Promise.resolve({ mime_type: 'image/png', data_base64: 'U3ludGhldGlj' }) : command === 'update_payroll_import_draft' ? Promise.resolve(savedRow(args.input)) : Promise.reject(Error('Blocked unexpected command')));
  const component = await wizard(true); await settle(component); const worker = await admitted(component);
  worker.emit({ type: 'analysis_stage', requestId: worker.messages.at(-1)!.requestId, label: 'Synthetic progress', percent: 42 }); component.flush();
  expect(text(component.tree)).toContain('Synthetic progress'); result(worker);
  await vi.waitFor(() => { component.flush(); expect(component.slots.some(slot => String(slot.value?.label).includes('page analysée'))).toBe(true); });
  const writes = runtime.invoke.mock.calls.filter(([command]) => command === 'update_payroll_import_draft'); expect(writes).toHaveLength(1);
  expect(writes[0][1].input.draft).toMatchObject({ gross_cents: 500000, net_cents: 500000, period: '2026-09' });
  expect(worker.terminated).toBe(false); expect((await ai()).isBusy()).toBe(false);
 });
 it('uses one warm worker for the next queued document and saves each draft once', async () => {
  runtime.invoke.mockImplementation((command: string, args: any) => command === 'get_payroll_document_preview' ? Promise.resolve({ mime_type: 'image/png', data_base64: 'U3ludGhldGlj' }) : command === 'update_payroll_import_draft' ? Promise.resolve(savedRow(args.input)) : Promise.reject(Error('Blocked unexpected command')));
  const component = await wizard(2); await settle(component); const worker = await admitted(component, true); result(worker);
  await vi.waitFor(() => expect(worker.messages.filter(value => value.type === 'analyze')).toHaveLength(2)); result(worker);
  await vi.waitFor(() => { component.flush(); expect(text(component.tree)).toContain('2/2 traités · 2 réussis'); });
  expect(ControlledWorker.instances).toHaveLength(1); expect(worker.messages.filter(value => value.type === 'check')).toHaveLength(1);
  expect(runtime.invoke.mock.calls.filter(([command]) => command === 'update_payroll_import_draft')).toHaveLength(2); expect(worker.terminated).toBe(false);
 });
 it('a chat begun synchronously when saving the settled analysis survives unmount and no save is replayed', async () => {
  const provider = await ai(); let component!: Host, request: Promise<void> | undefined, outcome = 'pending', aliveAtDispatch = false;
  runtime.invoke.mockImplementation((command: string, args: any) => {
   if (command === 'get_payroll_document_preview') return Promise.resolve({ mime_type: 'image/png', data_base64: 'U3ludGhldGlj' });
   if (command === 'update_payroll_import_draft') {
    request = provider.chat({ question: 'Synthetic follow-up', screen: 'Paie', facts: {}, history: [] }, () => {}).then(() => { outcome = 'success'; }, () => { outcome = 'rejected'; });
    aliveAtDispatch = provider.isBusy() && !ControlledWorker.instances.at(-1)!.terminated;
    component.unmount(); return Promise.resolve(savedRow(args.input));
   }
   throw Error('Blocked unexpected command');
  });
  component = await wizard(true); await settle(component); const worker = await admitted(component); result(worker);
  await vi.waitFor(() => expect(runtime.invoke.mock.calls.filter(([command]) => command === 'update_payroll_import_draft')).toHaveLength(1)); await settle(component);
  expect(aliveAtDispatch).toBe(true); expect(worker.terminated).toBe(false); expect(outcome).toBe('pending'); expect(component.unmountedWrites).toBe(0);
  worker.emit({ type: 'assistant_result', requestId: worker.messages.at(-1)!.requestId, output: 'Synthetic answer' }); await request; expect(outcome).toBe('success');
  expect(runtime.invoke.mock.calls.filter(([command]) => command === 'update_payroll_import_draft')).toHaveLength(1);
 });
  it('a check reply between layout detachment and passive cleanup cannot admit analysis', async () => {
   const component = await wizard(true); await settle(component); click(component, 'Analyser avec l’IA locale');
   await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1)); const worker = ControlledWorker.instances[0];
   component.detachBeforePassiveCleanup(); worker.emit({ type: 'check', mode: 'wasm' }); await settle(component);
   try {
    expect(ControlledWorker.instances.flatMap(value => value.messages).filter(value => value.type === 'analyze')).toHaveLength(0);
    expect(component.unmountedWrites).toBe(0); expect(runtime.invoke.mock.calls.every(([command]) => command === 'get_payroll_document_preview')).toBe(true);
   } finally { component.finishPassiveCleanup(); }
  });
});
