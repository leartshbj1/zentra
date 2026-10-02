import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn(), choose: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: runtime.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: runtime.choose }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useRef: (initial: unknown) => runtime.host.ref(initial),
  useState: (initial: unknown) => runtime.host.state(initial),
  useMemo: (factory: () => unknown, deps: unknown[]) => runtime.host.memo(factory, deps),
  useEffect: (setup: () => unknown, deps: unknown[]) => runtime.host.effect(setup, deps),
  useLayoutEffect: (setup: () => unknown, deps: unknown[]) => runtime.host.effect(setup, deps),
}));
vi.mock('./language', () => ({ t: (text: string) => text, useAppLanguage: () => 'fr', getAppLocale: () => 'fr-CH' }));
vi.mock('./ui', () => ({ Button: () => null, Field: () => null, Modal: () => null, ErrorPanel: () => null }));
vi.mock('./localPdfPreview', () => ({ prepareImageForAnalysis: vi.fn(), renderPdfPages: vi.fn() }));
vi.mock('./payrollPdfText', () => ({ extractPayrollPdfTextByPage: vi.fn() }));
vi.mock('./payrollLocalAi', () => ({ payrollLocalAi: { onProgress: () => () => {}, isBusy: () => false, cancel: vi.fn() } }));
import { PayrollImportWizard } from './PayrollImportWizard';
import { desktopApi, updatePayrollImportDraftMutation } from './bridge';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

class Host {
  slots: any[] = []; index = 0; effects: Array<() => void> = []; tree: any;
  mounted = true; dirty = false; unmountedWrites = 0; readOnly = false;
  close = vi.fn(() => this.unmount()); act = vi.fn(); reads: Array<(value: any) => void> = [];
  constructor(public workspace: any) {
    this.act.mockImplementation(async (action: () => Promise<any>, _message: string, _close: boolean, _onError: unknown, validate?: (value: any) => void) => {
      const origin = this.workspace.workNotesScope;
      const current = () => this.mounted && this.workspace.workNotesScope === origin;
      if (!current() || this.readOnly) return false;
      if (validate) this.reads.push(validate);
      try { await action(); return current(); }
      catch (reason) {
        if (!current()) return false;
        try { const next = await desktopApi.loadWorkspace(); validate?.(next); if (reason instanceof WorkspaceRefreshAfterMutationError) return true; }
        catch { /* The parent reports the original mutation rejection. */ }
        if (current() && typeof _onError === 'function') _onError(reason);
        return false;
      }
    });
    this.render();
  }
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
  effect(setup: () => unknown, deps: unknown[]) {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.effects.push(() => {
      previous?.cleanup?.(); this.slots[index] = { deps, cleanup: setup() };
    });
  }
  render() {
    this.index = 0; this.effects = []; this.dirty = false; runtime.host = this;
    this.tree = PayrollImportWizard({ workspace: this.workspace, close: this.close, act: this.act, readOnly: this.readOnly });
    for (const effect of this.effects) effect();
  }
  flush() { if (this.mounted && this.dirty) this.render(); }
  unmount() { for (const slot of this.slots) slot.cleanup?.(); this.mounted = false; }
}
type Element = { type?: unknown; props?: Record<string, any> };
function nodes(tree: unknown): Element[] { return Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Element, ...nodes((tree as Element).props?.children)]; }
function text(tree: unknown): string { return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text((tree as Element).props?.children) : ''; }
function button(host: Host, label: string) { const choices = nodes(host.tree).filter(value => value.props?.onClick && text(value.props.children).includes(label)); expect(choices).toHaveLength(1); return choices[0].props!.onClick as () => void; }
function review(host: Host) { const label = nodes(host.tree).find(value => value.type === 'label' && text(value).includes('J’ai comparé'))!; const check = nodes(label).find(value => value.type === 'input')!; check.props!.onChange({ target: { checked: true } }); host.flush(); }
function edit(host: Host, value: string) { const input = nodes(host.tree).find(value => value.type === 'input' && value.props?.value === 'Synthetic employee')!; input.props!.onChange({ target: { value } }); host.flush(); }
function next(host: Host) { const queue = nodes(host.tree).find(value => value.props?.className === 'payroll-import-queue')!; queue.props!.children[2].props.onClick(); host.flush(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function settle(host?: Host) { for (let n = 0; n < 60; n++) { await Promise.resolve(); host?.flush(); } }
function draft() { return { employee: { employeeNumber: '', name: 'Synthetic employee', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly' as const }, period: '2026-09', paymentDate: '2026-09-25', grossCents: 500000, netCents: 500000, lines: [{ id: 'synthetic-line', label: 'Synthetic wage', kind: 'earning' as const, amountCents: 500000, recurring: false, confidenceBp: 10000 }], warnings: [] }; }
function item(id = 'synthetic-import') { return { id, status: 'needs_review', mediaKind: 'image', sourceName: 'synthetic.png', extractionEngine: 'manual_review', engineVersion: '', extractedText: '', fileSha256: 'a'.repeat(64), fileSize: 128, analysisManifest: null, draft: draft() }; }
function row(id = 'synthetic-import', status = 'confirmed') { return { id, status, media_kind: 'image', source_name: 'synthetic.png', file_sha256: 'a'.repeat(64), extraction_engine: 'manual_review', draft_json: JSON.stringify(updatePayrollImportDraftMutation(id, draft(), '', '', 10000).args.input.draft) }; }
const hosts: Host[] = [];
let receiptScope = 'scope-a', receiptStatus = 'confirmed', failures = 0;
function host(count = 1) { const current = new Host({ workNotesScope: 'scope-a', payrollImports: Array.from({ length: count }, (_, index) => item(index ? 'synthetic-import-2' : 'synthetic-import')), employees: [], employeePayrollTemplates: [] }); hosts.push(current); return current; }
function commands(name: string) { return runtime.invoke.mock.calls.filter(([command]) => command === name); }
beforeEach(() => {
  hosts.length = 0; runtime.invoke.mockReset(); runtime.choose.mockReset(); receiptScope = 'scope-a'; receiptStatus = 'confirmed'; failures = 0;
  vi.stubGlobal('window', { atob: globalThis.atob, confirm: () => true });
  runtime.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === 'get_payroll_document_preview') return { mime_type: 'image/png', data_base64: 'U3ludGhldGlj' };
    if (['confirm_payroll_document_import','reject_payroll_document_import'].includes(command)) return;
    if (command === 'update_payroll_import_draft') return { ...row(args.input.id, 'needs_review'), draft_json: JSON.stringify(args.input.draft) };
    if (command === 'stage_payroll_documents') return { imports: [row('synthetic-import', 'needs_review')] };
    if (command === 'get_app_state') return { onboarding_completed: true };
    if (command === 'get_workspace') { if (failures-- > 0) throw Error('Synthetic read unavailable'); return { work_notes_scope: receiptScope, settings: {}, payroll_document_imports: [row('synthetic-import', receiptStatus), row('synthetic-import-2', 'needs_review')] }; }
    throw Error('Blocked synthetic IPC');
  });
});
afterEach(() => { for (const host of hosts) if (host.mounted) host.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('payroll import write admission and verified read receipts', () => {
  it('keeps one confirmation when its final GET fails but the read-only fallback succeeds', async () => {
    const current = host(); await settle(current); review(current); failures = 1;
    button(current, 'Confirmer et créer')(); await settle(current);
    expect(commands('confirm_payroll_document_import')).toHaveLength(1);
    expect(commands('get_workspace')).toHaveLength(2); expect(current.close).toHaveBeenCalledOnce();
    expect(current.reads).toHaveLength(1);
    expect(commands('confirm_payroll_document_import')[0][1].expectedWorkspaceScope).toBe('scope-a');
  });
  it('requires the confirmed status on the first successful receipt as well as every recovery read', async () => {
    const current = host(); await settle(current); review(current); receiptStatus = 'needs_review';
    button(current, 'Confirmer et créer')(); await settle(current);
    expect(current.close).not.toHaveBeenCalled(); expect(commands('confirm_payroll_document_import')).toHaveLength(1);
    expect(current.reads).toHaveLength(1);
    expect(() => current.reads[0]({ workNotesScope: 'scope-a', payrollImports: [item()] })).toThrow('confirmée');
    expect(() => current.reads[0]({ workNotesScope: 'scope-b', payrollImports: [{ ...item(), status: 'confirmed' }] })).toThrow('entreprise');
  });
  it('requires rejected status before removing an import', async () => {
    const current = host(); await settle(current); receiptStatus = 'needs_review';
    button(current, 'Écarter ce document')(); await settle(current);
    expect(text(current.tree)).toContain('synthetic.png');
    expect(current.reads).toHaveLength(1);
    expect(() => current.reads[0]({ workNotesScope: 'scope-a', payrollImports: [item()] })).toThrow('écarté');
    expect(commands('reject_payroll_document_import')[0][1].expectedWorkspaceScope).toBe('scope-a');
  });
  it('loads the preview with the scope of the document being reviewed', async () => {
    const current = host(); await settle(current);
    expect(commands('get_payroll_document_preview')[0][1]).toEqual({ id: 'synthetic-import', expectedWorkspaceScope: 'scope-a' });
  });
  it('admits two synchronous confirmation callbacks only once', async () => {
    const current = host(); await settle(current); review(current); const held = deferred<void>(), original = runtime.invoke.getMockImplementation()!;
    runtime.invoke.mockImplementation((command, args) => command === 'confirm_payroll_document_import' ? held.promise : original(command, args));
    const confirm = button(current, 'Confirmer et créer'); confirm(); confirm(); await settle(current);
    expect(commands('confirm_payroll_document_import')).toHaveLength(1); held.resolve(); await settle(current); expect(current.close).toHaveBeenCalledOnce();
  });
  it('does not start a stale callback or setter after unmount', async () => {
    const current = host(); await settle(current); review(current); const confirm = button(current, 'Confirmer et créer'); current.unmount(); confirm(); await settle();
    expect(commands('confirm_payroll_document_import')).toHaveLength(0); expect(current.unmountedWrites).toBe(0);
  });
  it('does not send old drafts or old IDs when the mounted Wizard receives another scope with the same ID', async () => {
    const current = host(); await settle(current); review(current); const stale = button(current, 'Confirmer et créer');
    current.workspace = { ...current.workspace, workNotesScope: 'scope-b' }; current.render(); stale(); await settle(current);
    expect(commands('confirm_payroll_document_import')).toHaveLength(0);
    expect(commands('get_payroll_document_preview')).toHaveLength(1);
    expect(text(current.tree)).not.toContain('Synthetic employee'); expect(button(current, 'Fermer')).toBeDefined();
  });
  it('does not publish local completion after a confirmed write finishes after unmount', async () => {
    const current = host(); await settle(current); review(current); const held = deferred<void>(), original = runtime.invoke.getMockImplementation()!;
    runtime.invoke.mockImplementation((command, args) => command === 'confirm_payroll_document_import' ? held.promise : original(command, args));
    button(current, 'Confirmer et créer')(); await settle(current); current.unmount(); held.resolve(); await settle();
    expect(commands('confirm_payroll_document_import')).toHaveLength(1); expect(current.close).not.toHaveBeenCalled(); expect(current.unmountedWrites).toBe(0);
  });
  it('stops a sequence of draft saves when the first ACK arrives after unmount', async () => {
    const current = host(2); await settle(current); edit(current, 'Synthetic edit one'); next(current); edit(current, 'Synthetic edit two');
    const held = deferred<any>(), original = runtime.invoke.getMockImplementation()!;
    runtime.invoke.mockImplementation((command, args) => command === 'update_payroll_import_draft' ? held.promise : original(command, args));
    button(current, 'Continuer plus tard')(); await settle(current); current.unmount(); held.resolve(row()); await settle();
    expect(commands('update_payroll_import_draft')).toHaveLength(1); expect(current.unmountedWrites).toBe(0);
  });
  it('stops new writes after read-only arrives and resumes only the draft without an ACK', async () => {
    const current = host(2); await settle(current); edit(current, 'Synthetic edit one'); next(current); edit(current, 'Synthetic edit two');
    const held = deferred<any>(), original = runtime.invoke.getMockImplementation()!;
    runtime.invoke.mockImplementation((command, args) => command === 'update_payroll_import_draft' && commands(command).length === 1 ? held.promise : original(command, args));
    button(current, 'Continuer plus tard')(); await settle(current); current.readOnly = true; current.render(); held.resolve(row()); await settle(current);
    expect(commands('update_payroll_import_draft')).toHaveLength(1); expect(current.close).not.toHaveBeenCalled();
    current.readOnly = false; current.render(); button(current, 'Continuer plus tard')(); await settle(current);
    expect(commands('update_payroll_import_draft').map(call => call[1].input.id)).toEqual(['synthetic-import','synthetic-import-2']);
    expect(commands('update_payroll_import_draft').every(call => call[1].expectedWorkspaceScope === 'scope-a')).toBe(true);
    expect(current.close).toHaveBeenCalledOnce();
  });
  it('does not stage file paths returned after the Wizard closes', async () => {
    const current = host(0); await settle(current); const held = deferred<string[]>(); runtime.choose.mockReturnValue(held.promise);
    button(current, 'Choisir les documents')(); await settle(current); current.unmount(); held.resolve(['synthetic.png']); await settle();
    expect(commands('stage_payroll_documents')).toHaveLength(0); expect(current.unmountedWrites).toBe(0);
  });
  it('recovers the read after acknowledged draft saves without repeating the saved drafts', async () => {
    const current = host(); await settle(current); edit(current, 'Synthetic edit'); failures = 1;
    button(current, 'Continuer plus tard')(); await settle(current);
    expect(commands('update_payroll_import_draft')).toHaveLength(1); expect(commands('get_workspace')).toHaveLength(2);
    expect(current.close).toHaveBeenCalledOnce();
  });
  it('blocks all write callbacks in read-only mode while keeping an untouched Wizard closable', async () => {
    const current = host(); await settle(current); review(current); current.readOnly = true; current.render();
    button(current, 'Confirmer et créer')(); button(current, 'Écarter ce document')(); await settle(current);
    expect(commands('confirm_payroll_document_import')).toHaveLength(0); expect(commands('reject_payroll_document_import')).toHaveLength(0);
    current.tree.props.onClose(); await settle(); expect(current.close).toHaveBeenCalledOnce();
  });
  it('explains a refused close in read-only mode without discarding edits or writing them', async () => {
    const current = host(); await settle(current); edit(current, 'Synthetic retained edit');
    current.readOnly = true; current.render(); current.tree.props.onClose(); await settle(current);
    expect(current.close).not.toHaveBeenCalled(); expect(commands('update_payroll_import_draft')).toHaveLength(0);
    expect(nodes(current.tree).some(value => String(value.props?.message).includes('consultation uniquement'))).toBe(true);
    expect(nodes(current.tree).some(value => value.props?.value === 'Synthetic retained edit')).toBe(true);
  });
  it('shows the original native rejection in the Wizard and retains the document without automatic retry', async () => {
    const current = host(); await settle(current); review(current); receiptStatus = 'needs_review';
    const rejection = new Error('Accès refusé : votre rôle permet la consultation uniquement.'), original = runtime.invoke.getMockImplementation()!;
    runtime.invoke.mockImplementation((command, args) => command === 'confirm_payroll_document_import' ? Promise.reject(rejection) : original(command, args));
    button(current, 'Confirmer et créer')(); await settle(current);
    expect(commands('confirm_payroll_document_import')).toHaveLength(1); expect(current.close).not.toHaveBeenCalled();
    expect(text(current.tree)).toContain('synthetic.png');
    expect(nodes(current.tree).some(value => value.props?.message === rejection.message)).toBe(true);
    expect(nodes(current.tree).some(value => value.props?.value === 'Synthetic employee')).toBe(true);
  });
});
