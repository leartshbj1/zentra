import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeDocumentDraft } from './employeeDocumentDraft';

// Real component and provider, deterministic React hooks and a controlled
// Worker. PDF helpers are synthetic; no model, OCR, native IPC or network runs.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn(), textReads: 0 }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: runtime.invoke }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: (initial: unknown) => runtime.host.ref(initial),
  useState: (initial: unknown) => runtime.host.state(initial),
  useEffect: (setup: () => unknown, deps: unknown[]) => runtime.host.effect(setup, deps),
}));
vi.mock('./language', () => ({ t: (text: string) => text, useAppLanguage: () => 'fr' }));
vi.mock('./ui', () => ({ Button: () => null }));
vi.mock('./ErrorGuidance', () => ({ ErrorDetails: () => null }));
vi.mock('./localPdfPreview', () => ({ prepareImageForAnalysis: vi.fn(), renderPdfPages: vi.fn() }));
vi.mock('./payrollPdfText', () => ({ extractPayrollPdfTextByPage: async () => {
  runtime.textReads++;
  return { pageCount: 1, pages: ['Synthetic employee salary text '.repeat(15)] };
} }));

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  terminated = false;
  messages: Array<Record<string, unknown>> = [];
  listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor() { ControlledWorker.instances.push(this); }
  addEventListener(type: string, callback: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
  }
  postMessage(message: Record<string, unknown>) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { for (const listener of this.listeners.get('message') || []) listener({ data }); }
}
type Element = { type?: unknown; props?: Record<string, any> };
class Host {
  slots: any[] = []; index = 0; pendingEffects: Array<() => void> = [];
  mounted = true; dirty = false; writes: unknown[] = []; tree: unknown;
  constructor(public component: (props: any) => unknown, public onRead = vi.fn()) { this.render(); }
  ref(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
  state(initial: unknown) {
    const slot = this.slots[this.index++] ??= { value: initial };
    return [slot.value, (value: unknown) => { this.writes.push(value); slot.value = value; this.dirty = true; }];
  }
  effect(setup: () => unknown, deps: unknown[]) {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) {
      this.pendingEffects.push(() => {
        previous?.cleanup?.(); this.slots[index] = { setup, deps, cleanup: setup() };
      });
    }
  }
  render() {
    this.index = 0; this.pendingEffects = []; this.dirty = false; runtime.host = this;
    this.tree = this.component({ onRead: this.onRead, disabled: false });
    for (const effect of this.pendingEffects) effect();
  }
  flush() { if (this.mounted && this.dirty) this.render(); }
  replayEffects() { for (const slot of this.slots) if (slot.setup) { slot.cleanup?.(); slot.cleanup = slot.setup(); } }
  unmount() { for (const slot of this.slots) slot.cleanup?.(); this.mounted = false; }
}
function nodes(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree as Element, ...nodes((tree as Element).props?.children)];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
const ai = async () => (await import('./payrollLocalAi')).payrollLocalAi;
const hosts: Host[] = [];
async function host() {
  const { EmployeeDocumentImport } = await import('./EmployeeDocumentImport');
  const next = new Host(EmployeeDocumentImport); hosts.push(next); return next;
}
function choose(host: Host, opening = Promise.resolve(new Uint8Array([1, 2, 3]).buffer)) {
  const input = nodes(host.tree).find(element => element.type === 'input'); expect(input).toBeDefined();
  input!.props!.onChange({ currentTarget: { files: [{ size: 128, name: 'synthetic.pdf', arrayBuffer: () => opening }], value: 'synthetic.pdf' } });
  host.flush();
}
const alert = (host: Host) => nodes(host.tree).find(element => element.props?.role === 'alert')?.props?.children ?? '';
function cancelImport(host: Host) {
  const action = nodes(host.tree).find(element => element.props?.onClick); expect(action).toBeDefined();
  action!.props!.onClick(); host.flush();
}
async function idle(host: Host) {
  await vi.waitFor(() => { host.flush(); expect(host.slots[3].value).toBe(false); });
}
async function analysis(host: Host) {
  await vi.waitFor(() => { host.flush(); expect(ControlledWorker.instances).toHaveLength(1); });
  const worker = ControlledWorker.instances[0]; expect(worker.messages[0].type).toBe('analyze'); return worker;
}
function finishAnalysis(worker: ControlledWorker) {
  const employeeDraft = { fields: { name: 'Synthetic Employee' }, warnings: [] } as EmployeeDocumentDraft;
  worker.emit({ type: 'analysis', requestId: worker.messages[0].requestId,
    primaryOutput: '{}', verifiedOutput: '', employeeDraft, mode: 'wasm' }); return employeeDraft;
}
async function assistant() {
  const provider = await ai(); let outcome = 'pending';
  const request = provider.chat({ question: 'Synthetic help', screen: 'Paie', facts: {}, history: [] }, () => {})
    .then(() => { outcome = 'success'; }, () => { outcome = 'rejected'; });
  const worker = ControlledWorker.instances[ControlledWorker.instances.length - 1];
  return { provider, worker, request, outcome: () => outcome, finish() {
    worker.emit({ type: 'assistant_result', requestId: worker.messages[0].requestId, output: 'Synthetic answer' });
  } };
}
beforeEach(() => {
  vi.resetModules(); runtime.invoke.mockReset(); runtime.host = null; runtime.textReads = 0;
  ControlledWorker.instances = []; hosts.length = 0;
  vi.stubGlobal('Worker', ControlledWorker); vi.stubGlobal('window', {});
});
afterEach(async () => {
  for (const current of hosts) if (current.mounted) current.unmount();
  (await ai()).cancel(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('employee document import owns only its admitted local analysis', () => {
  it('provider control preserves an assistant when a competing analysis is rejected', async () => {
    const current = await assistant();
    await expect(current.provider.analyze({ extractedText: 'Synthetic document' })).rejects.toThrow('déjà utilisé');
    expect(current.worker.terminated).toBe(false); expect(current.outcome()).toBe('pending');
    current.finish(); await current.request; expect(current.outcome()).toBe('success');
  });
  it('a busy refusal leaves the assistant pending and does not claim its progress or cancellation', async () => {
    const current = await assistant(), cancel = vi.spyOn(current.provider, 'cancel'), progress = vi.spyOn(current.provider, 'onProgress');
    const component = await host(); choose(component);
    await vi.waitFor(() => { component.flush(); expect(alert(component)).toContain('déjà utilisé'); }); await idle(component);
    expect(component.onRead).not.toHaveBeenCalled(); expect(current.worker.messages.map(value => value.type)).toEqual(['assistant_chat']);
    expect(current.worker.terminated).toBe(false); expect(cancel).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
    expect(current.outcome()).toBe('pending'); current.finish(); await current.request; expect(current.outcome()).toBe('success');
  });
  it('normal import keeps progress, publishes its draft once, and closes its completed worker', async () => {
    const component = await host(); choose(component); const worker = await analysis(component);
    worker.emit({ type: 'analysis_stage', requestId: worker.messages[0].requestId, label: 'Synthetic reading', percent: 42 });
    component.flush(); expect(component.slots[4].value).toEqual({ label: 'Synthetic reading', percent: 42 });
    const draft = finishAnalysis(worker); await idle(component);
    expect(component.onRead).toHaveBeenCalledExactlyOnceWith(draft); expect(worker.terminated).toBe(true); expect((await ai()).isBusy()).toBe(false);
  });
  it.each([false, true])('a synchronous onRead chat survives cleanup of the resolved analysis, freshWorker=%s', async freshWorker => {
    const provider = await ai(), component = await host();
    let request: Promise<void> | undefined, outcome = 'pending', admittedBusy = false, liveBeforeCleanup = false;
    let assistantWorker: ControlledWorker | undefined;
    component.onRead.mockImplementation(() => {
      if (freshWorker) provider.releaseIfIdle();
      request = provider.chat({ question: 'Synthetic follow-up', screen: 'Paie', facts: {}, history: [] }, () => {})
        .then(() => { outcome = 'success'; }, () => { outcome = 'rejected'; });
      assistantWorker = ControlledWorker.instances[ControlledWorker.instances.length - 1];
      admittedBusy = provider.isBusy(); liveBeforeCleanup = !assistantWorker.terminated;
    });
    choose(component); const worker = await analysis(component); finishAnalysis(worker); await idle(component);
    expect(component.onRead).toHaveBeenCalledOnce(); expect(admittedBusy).toBe(true); expect(liveBeforeCleanup).toBe(true);
    expect(assistantWorker).toBeDefined(); expect(assistantWorker!.messages.at(-1)?.type).toBe('assistant_chat');
    if (freshWorker) expect(assistantWorker).not.toBe(worker);
    expect(assistantWorker!.terminated).toBe(false); expect(outcome).toBe('pending');
    assistantWorker!.emit({ type: 'assistant_result', requestId: assistantWorker!.messages.at(-1)!.requestId, output: 'Synthetic answer' });
    await request; expect(outcome).toBe('success');
    component.unmount(); expect(assistantWorker!.terminated).toBe(false);
  });
  it.each([false, true])('a synchronous onRead chat and unmount retire only the settled import, freshWorker=%s', async freshWorker => {
    const provider = await ai(), component = await host();
    let request: Promise<void> | undefined, outcome = 'pending', admittedBusy = false, liveBeforeCleanup = false, writesAtUnmount = 0;
    let assistantWorker: ControlledWorker | undefined;
    component.onRead.mockImplementation(() => {
      if (freshWorker) provider.releaseIfIdle();
      request = provider.chat({ question: 'Synthetic follow-up', screen: 'Paie', facts: {}, history: [] }, () => {})
        .then(() => { outcome = 'success'; }, () => { outcome = 'rejected'; });
      assistantWorker = ControlledWorker.instances[ControlledWorker.instances.length - 1];
      admittedBusy = provider.isBusy(); liveBeforeCleanup = !assistantWorker.terminated;
      component.unmount(); writesAtUnmount = component.writes.length;
    });
    choose(component); const worker = await analysis(component); finishAnalysis(worker);
    await vi.waitFor(() => expect(component.onRead).toHaveBeenCalledOnce()); await Promise.resolve();
    expect(admittedBusy).toBe(true); expect(liveBeforeCleanup).toBe(true);
    expect(assistantWorker!.messages.at(-1)?.type).toBe('assistant_chat');
    if (freshWorker) expect(assistantWorker).not.toBe(worker);
    expect({ terminated: assistantWorker!.terminated, lateWrites: component.writes.length - writesAtUnmount }).toEqual({ terminated: false, lateWrites: 0 });
    expect(outcome).toBe('pending');
    assistantWorker!.emit({ type: 'assistant_result', requestId: assistantWorker!.messages.at(-1)!.requestId, output: 'Synthetic answer' });
    await request; expect(outcome).toBe('success');
  });
  it('an onRead unmount still releases the completed idle worker without late setters', async () => {
    const component = await host(); let writesAtUnmount = 0;
    component.onRead.mockImplementation(() => { component.unmount(); writesAtUnmount = component.writes.length; });
    choose(component); const worker = await analysis(component); finishAnalysis(worker);
    await vi.waitFor(() => expect(component.onRead).toHaveBeenCalledOnce());
    expect(worker.terminated).toBe(true); expect(component.writes).toHaveLength(writesAtUnmount);
    expect((await ai()).isBusy()).toBe(false);
  });
  it('explicit cancellation stops its admitted analysis without a draft or a cancellation error', async () => {
    const component = await host(); choose(component); const worker = await analysis(component);
    cancelImport(component); await idle(component); finishAnalysis(worker); await Promise.resolve(); component.flush();
    expect(worker.terminated).toBe(true); expect(component.onRead).not.toHaveBeenCalled(); expect(alert(component)).toBe('');
    expect(component.slots[5].value).toContain('Lecture annulée'); expect((await ai()).isBusy()).toBe(false);
  });
  it('unmount after an explicit cancellation does not cancel a subsequent assistant', async () => {
    const component = await host(); choose(component); const worker = await analysis(component);
    cancelImport(component); await idle(component); expect(worker.terminated).toBe(true);
    const current = await assistant();
    expect(current.worker).not.toBe(worker); expect(current.worker.terminated).toBe(false);
    component.unmount(); expect(current.worker.terminated).toBe(false); expect(current.outcome()).toBe('pending');
    current.finish(); await current.request;
  });
  it('unmount stops an admitted analysis and suppresses its late draft and setters', async () => {
    const component = await host(); choose(component); const worker = await analysis(component);
    component.unmount(); const writes = component.writes.length; finishAnalysis(worker); await Promise.resolve(); await Promise.resolve();
    expect(worker.terminated).toBe(true); expect(component.onRead).not.toHaveBeenCalled(); expect(component.writes).toHaveLength(writes);
  });
  it('a document opened after another assistant starts refuses without cancelling that assistant', async () => {
    const opening = deferred<ArrayBuffer>(), component = await host(); choose(component, opening.promise);
    const current = await assistant(); opening.resolve(new Uint8Array([1, 2, 3]).buffer);
    await vi.waitFor(() => { component.flush(); expect(alert(component)).toContain('déjà utilisé'); }); await idle(component);
    expect(current.worker.terminated).toBe(false); expect(current.outcome()).toBe('pending'); expect(component.onRead).not.toHaveBeenCalled();
    current.finish(); await current.request; expect(current.outcome()).toBe('success');
  });
  it('unmount during document opening does not claim or cancel another operation', async () => {
    const opening = deferred<ArrayBuffer>(), component = await host(); choose(component, opening.promise);
    const current = await assistant(); component.unmount(); const writes = component.writes.length;
    opening.resolve(new Uint8Array([1, 2, 3]).buffer); await vi.waitFor(() => expect(runtime.textReads).toBe(1));
    await Promise.resolve(); expect(current.worker.messages).toHaveLength(1); expect(current.worker.terminated).toBe(false);
    expect(component.writes).toHaveLength(writes); expect(component.onRead).not.toHaveBeenCalled();
    current.finish(); await current.request;
  });
  it('StrictMode-style idle effect replay never acquires or cancels an unrelated assistant', async () => {
    const current = await assistant(), cancel = vi.spyOn(current.provider, 'cancel'), component = await host();
    component.replayEffects(); component.unmount();
    expect(cancel).not.toHaveBeenCalled(); expect(current.worker.terminated).toBe(false); expect(current.outcome()).toBe('pending');
    current.finish(); await current.request;
  });
});
