import type { WorkspaceMutationOrigin } from './workspaceMemberOrigin';
// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/** Actual ContactForms, uncontrolled-field adapter, FormDraftSession, bridge and
 * createWorkspaceEntity; synthetic native invoke and explicitly failing browser
 * Storage only. No live customer data, no native executable, no server proof.
 * The small executor deliberately exposes generic ID-only recovery, but does not
 * pretend to execute WorkspaceApp lifecycle or prove cross-device operation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import type { Client, Supplier, Workspace } from './types';
const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: nativeInvoke }));
const companyId = 'synthetic-contact-workspace';
const memberId = 'synthetic-contact-member';
const memberContextNonce = '0123456789abcdef0123456789abcdef';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
type Kind = 'client' | 'supplier';
const fields: Record<Kind, Record<string, string>> = {
  client: { contactPerson: 'Personne témoin', company: 'Entreprise témoin', email: 'contact@example.test', phone: '', street: 'Rue témoin', buildingNumber: '7', postalCode: '1200', city: 'Genève', canton: 'GE', country: 'CH', notes: 'Contact de test' },
  supplier: { name: 'Fournisseur témoin', contactName: 'Contact achats', email: 'supplier@example.test', phone: '', address: 'Rue témoin 7\n1200 Genève', uidNumber: '', iban: '', paymentTermsDays: '30', notes: 'Fournisseur de test' },
};
class FaultStorage implements Storage {
  readonly data = new Map<string, string>();
  retireKey: string | null = null;
  captureFailureKey: string | null = null;
  loseCaptureKey: string | null = null;
  failedRetirements: string[] = [];
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (key === this.captureFailureKey) throw new DOMException('Capture refused', 'QuotaExceededError');
    if (key === this.loseCaptureKey) return;
    if (this.retireKey && key === this.retireKey.replace('.drafts.', '.completed.')) {
      this.failedRetirements.push('marker'); throw new DOMException('Marker refused', 'QuotaExceededError');
    }
    if (key === this.retireKey && JSON.parse(value).acknowledged === true) {
      this.failedRetirements.push('tombstone'); throw new DOMException('Acknowledgement refused', 'QuotaExceededError');
    }
    this.data.set(key, value);
  }
  removeItem(key: string) {
    if (key === this.retireKey) { this.failedRetirements.push('remove'); throw new DOMException('Removal refused', 'SecurityError'); }
    this.data.delete(key);
  }
}
async function loadRuntime() {
  const react = await import('react');
  const dom = await import('react-dom/client');
  const forms = await import('./ContactForms');
  const draftHook = await import('./useFormDraft');
  const drafts = await import('./formDrafts');
  const { desktopApi } = await import('./bridge');
  const creation = await import('./workspaceCreation');
  return { react, dom, forms, draftHook, drafts, desktopApi, creation };
}
type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type View = { root: Root; host: HTMLElement; runtime: Runtime };
let views: View[] = [];
let runtime: Runtime;
let storage: FaultStorage;
let rows: Record<Kind, Map<string, Record<string, unknown>>>;
let rejectCreate: boolean;
let commitThenLoseReply: boolean;
let arrivingOldRow: Record<string, unknown> | undefined;
let readScope: string;
let scrollDescriptor: PropertyDescriptor | undefined;
const entity = (kind: Kind) => kind === 'client' ? 'clients' : 'suppliers';
function calls(command: string) { return nativeInvoke.mock.calls.filter(([name]) => name === command); }
function key(kind: Kind, recordId?: string) { return runtime.drafts.formDraftKey({ companyId, memberId, type: kind, recordId }); }
function stored(kind: Kind, recordId?: string) {
  const value = storage.getItem(key(kind, recordId)); expect(value).not.toBeNull();
  return JSON.parse(value!) as { value: Record<string, string> };
}
function seed(kind: Kind, value: Record<string, string>, recordId?: string, fingerprint = 'new') {
  const scope = key(kind, recordId);
  storage.setItem(scope, JSON.stringify({ version: 1, scope, fingerprint, savedAt: Date.now(), value }));
}
function form() {
  const result = document.querySelector<HTMLFormElement>('[role="dialog"] form');
  if (!result) throw Error('Actual contact form missing');
  return result;
}
function field(name: string) {
  const result = form().elements.namedItem(name);
  if (!(result instanceof HTMLInputElement || result instanceof HTMLTextAreaElement || result instanceof HTMLSelectElement)) throw Error('Missing field ' + name);
  return result;
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(row => row.textContent?.trim() === label);
  if (!result) throw Error('Missing button ' + label);
  return result;
}
function setBrowserValue(name: string, value: string) {
  const control = field(name);
  const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
}
async function change(name: string, value: string) {
  await runtime.react.act(async () => { setBrowserValue(name, value); field(name).dispatchEvent(new Event('input', { bubbles: true })); field(name).dispatchEvent(new Event('change', { bubbles: true })); });
}
async function fill(kind: Kind) { for (const [name, value] of Object.entries(fields[kind])) await change(name, value); }
async function click(label: string) { await runtime.react.act(async () => { expect(button(label).disabled).toBe(false); button(label).click(); }); }
function executor() {
  const failures: unknown[] = [], outcomes: boolean[] = [];
  let pending: Promise<boolean> | undefined;
  const act = (action: (origin: WorkspaceMutationOrigin) => Promise<Workspace>, _message: string, _close?: boolean, onError?: (error: unknown) => void) => {
    pending = (async () => {
      try { await action({workspaceScope:companyId,memberContextNonce}); outcomes.push(true); return true; }
      catch (reason) {
        failures.push(reason);
        // An unsafe generic error would return true merely because an older
        // record with the same UUID is now visible. The wrapper must stop this.
        if (reason instanceof runtime.creation.WorkspaceCreationOutcomeUnknownError && reason.wasRecorded(await runtime.desktopApi.loadWorkspace())) {
          outcomes.push(true); return true;
        }
        onError?.(reason); outcomes.push(false); return false;
      }
    })();
    return pending;
  };
  return { act, failures, outcomes, latest: () => pending, clear: () => { pending = undefined; } };
}
async function submit(run: ReturnType<typeof executor>, expectedAction = true) {
  run.clear();
  await runtime.react.act(async () => {
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    if (expectedAction) { expect(run.latest()).toBeDefined(); await run.latest(); }
    else expect(run.latest()).toBeUndefined();
  });
}
async function mount(kind: Kind, workspace: Workspace, run: ReturnType<typeof executor>, item?: Client | Supplier, identity: { memberId: string; ready: boolean; memberContextNonce?: string } = { memberId, memberContextNonce, ready: true }, readOnly = false, onClose: () => void = () => {}) {
  const host = document.createElement('div'); document.body.append(host);
  const root = runtime.dom.createRoot(host);
  const common = { workspace, busy: false, readOnly, close: onClose, act: run.act };
  const content = kind === 'client'
    ? runtime.react.createElement(runtime.forms.ClientForm, { ...common, item: item as Client | undefined })
    : runtime.react.createElement(runtime.forms.SupplierForm, { ...common, item: item as Supplier | undefined });
  await runtime.react.act(async () => root.render(runtime.react.createElement(runtime.draftHook.FormDraftIdentityProvider, {
    companyId, ...identity, children: content,
  })));
  const view = { root, host, runtime }; views.push(view); return view;
}
async function unmount(view: View) { await view.runtime.react.act(async () => view.root.unmount()); view.host.remove(); views = views.filter(row => row !== view); }
beforeEach(async () => {
  vi.resetModules(); nativeInvoke.mockReset();
  storage = new FaultStorage(); rows = { client: new Map(), supplier: new Map() };
  rejectCreate = false; commitThenLoseReply = false; arrivingOldRow = undefined; readScope = companyId;
  vi.stubGlobal('localStorage', storage); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  nativeInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (args?.expectedMemberContextNonce !== undefined) expect(args.expectedMemberContextNonce).toBe(memberContextNonce);
    if (command === 'get_app_state') return { onboarding_completed: true, data_dir: 'synthetic-only', database_path: 'synthetic-only', app_version: 'candidate' };
    if (command === 'get_workspace') return { work_notes_scope: readScope, clients: [...rows.client.values()], suppliers: [...rows.supplier.values()] };
    if (command === 'create_record') {
      const kind = args?.entity === 'clients' ? 'client' : 'supplier';
      const data = args?.data as Record<string, unknown>;
      if (arrivingOldRow) { rows[kind].set(String(arrivingOldRow.id), structuredClone(arrivingOldRow)); arrivingOldRow = undefined; throw Error('UNIQUE constraint failed'); }
      if (rejectCreate) throw Error('Native invocation refused before persistence');
      expect(rows[kind].has(String(data.id))).toBe(false); rows[kind].set(String(data.id), structuredClone(data));
      if (commitThenLoseReply) throw Error('Reply lost after native persistence');
      return structuredClone(data);
    }
    if (command === 'update_record') {
      const kind = args?.entity === 'clients' ? 'client' : 'supplier';
      const id = String(args?.id); expect(rows[kind].has(id)).toBe(true);
      rows[kind].set(id, { ...rows[kind].get(id), ...structuredClone(args?.data as Record<string, unknown>) }); return null;
    }
    throw Error('Unexpected native command ' + command);
  });
  runtime = await loadRuntime();
});
afterEach(async () => {
  for (const view of [...views]) await unmount(view);
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  vi.unstubAllGlobals();
});
describe.each(['client', 'supplier'] as const)('durable %s creation', kind => {
  it('confirms UUID storage before native write, forwards scope and retires only ACK', async () => {
    const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind);
    const id = stored(kind).value.creationId; expect(id).toMatch(uuid);
    expect(form().elements.namedItem('creationId')).toBeNull();
    await submit(run); expect(run.outcomes).toEqual([true]); expect(calls('create_record')).toHaveLength(1);
    expect(calls('create_record')[0][1]).toMatchObject({ entity: entity(kind), expectedWorkspaceScope: companyId, data: { id } });
    expect(calls('create_record')[0][1].data).not.toHaveProperty('creationId'); expect(storage.getItem(key(kind))).toBeNull();
  });
  it('explicit abandon closes a new creation only after durable discard, and reopening receives a new UUID', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const closed = vi.fn();
    const run = executor(); const view = await mount(kind, await runtime.desktopApi.loadWorkspace(), run, undefined, undefined, false, closed); await fill(kind);
    const id = stored(kind).value.creationId; commitThenLoseReply = true; await submit(run);
    expect(run.outcomes).toEqual([false]); expect(rows[kind].has(id)).toBe(true);
    await click('Abandonner le brouillon'); expect(closed).toHaveBeenCalledTimes(1); expect(storage.getItem(key(kind))).toBeNull();
    await unmount(view); commitThenLoseReply = false;
    const next = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), next); await fill(kind);
    expect(stored(kind).value.creationId).not.toBe(id); await submit(next);
    expect(calls('create_record')).toHaveLength(2); expect(rows[kind].size).toBe(2); confirmed.mockRestore();
  });
  it('retains UUID through three failed retirements and process restart; existing record is not recreated or acknowledged blindly', async () => {
    let run = executor(); let view = await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind);
    const id = stored(kind).value.creationId; storage.retireKey = key(kind); await submit(run);
    expect(run.outcomes).toEqual([true]); expect(storage.failedRetirements).toEqual(['marker', 'remove', 'tombstone']);
    const raw = storage.getItem(key(kind)); expect(raw).not.toBeNull(); await unmount(view);
    vi.resetModules(); runtime = await loadRuntime(); run = executor();
    view = await mount(kind, await runtime.desktopApi.loadWorkspace(), run);
    await submit(run, false); await click('Reprendre ma saisie'); expect(stored(kind).value.creationId).toBe(id);
    await submit(run); expect(run.outcomes).toEqual([false]); expect(calls('create_record')).toHaveLength(1);
    // A deliberate submit refreshes savedAt synchronously; it must preserve the
    // exact original identity and values rather than retire or replace the draft.
    expect(JSON.parse(storage.getItem(key(kind))!).value).toEqual(JSON.parse(raw!).value);
    expect(form().textContent).toContain('existe déjà');
  });
  it('blocks submission when this capture fails although the previous render/storage succeeded; retry keeps the same UUID', async () => {
    const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind);
    const before = stored(kind), id = before.value.creationId;
    const target = kind === 'client' ? 'company' : 'name';
    setBrowserValue(target, 'Dernière saisie non rendue'); storage.captureFailureKey = key(kind);
    await submit(run, false); expect(calls('create_record')).toHaveLength(0); expect(field(target).value).toBe('Dernière saisie non rendue');
    expect(stored(kind).value.creationId).toBe(id); expect(form().textContent).toContain('ne peut pas être conservée');
    const localGuide = form().querySelector('[data-contact-storage-recovery]');
    expect(localGuide?.textContent).toContain('sauvegarde locale');
    expect(form().querySelector('.contact-form-failure')?.textContent).not.toContain('Action à vérifier');
    storage.captureFailureKey = null;
    const retry = form().querySelector<HTMLButtonElement>('.contact-form-failure .error-guidance__actions button');
    expect(retry).not.toBeNull(); await runtime.react.act(async () => retry!.click());
    expect(calls('create_record')).toHaveLength(0);
    expect(form().querySelector('[data-contact-storage-recovery]')).toBeNull();
    expect(stored(kind).value[target]).toBe('Dernière saisie non rendue'); await submit(run);
    expect(calls('create_record')[0][1].data.id).toBe(id); expect(run.outcomes).toEqual([true]);
  });
  it('blocks native write on failed readback even if setItem returned normally', async () => {
    const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind);
    const before = storage.getItem(key(kind)); setBrowserValue('notes', 'Dernière correction sans événement'); storage.loseCaptureKey = key(kind);
    await submit(run, false); expect(calls('create_record')).toHaveLength(0); expect(storage.getItem(key(kind))).toBe(before);
  });
  it('restores legacy text without assigning an identity until the explicit history-review choice', async () => {
    seed(kind, fields[kind]); const raw = storage.getItem(key(kind)); const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run);
    await submit(run, false); await click('Reprendre ma saisie'); await submit(run, false);
    expect(storage.getItem(key(kind))).toBe(raw); expect(stored(kind).value).not.toHaveProperty('creationId');
    expect(form().textContent).toContain('Ce brouillon ancien'); expect(field(kind === 'client' ? 'company' : 'name').matches(':disabled')).toBe(true);
    await click('Préparer une nouvelle fiche'); expect(stored(kind).value.creationId).toMatch(uuid);
    expect(stored(kind).value).toMatchObject(fields[kind]); await submit(run); expect(run.outcomes).toEqual([true]);
  });
  it('refuses malformed recovered identity without discarding the original draft', async () => {
    seed(kind, { ...fields[kind], creationId: 'not-a-uuid' }); const raw = storage.getItem(key(kind)); const run = executor();
    await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await submit(run, false);
    expect(calls('create_record')).toHaveLength(0); expect(storage.getItem(key(kind))).toBe(raw); expect(form().textContent).toContain('Ce brouillon ne peut plus être repris');
  });
  it('does not use UUID-only proof when an older row arrives after preflight with different fields', async () => {
    const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind);
    const id = stored(kind).value.creationId; arrivingOldRow = { id, name: 'Ancienne version non conforme', email: 'old@example.test' };
    await submit(run); expect(run.outcomes).toEqual([false]); expect(calls('create_record')).toHaveLength(1);
    expect(run.failures[0]).not.toBeInstanceOf(runtime.creation.WorkspaceCreationOutcomeUnknownError);
    expect((run.failures[0] as Error).cause).toBeInstanceOf(runtime.creation.WorkspaceCreationOutcomeUnknownError);
    expect(stored(kind).value.creationId).toBe(id); expect(form().querySelector('[data-contact-creation-recovery]')?.textContent).toContain('Vérifiez la liste');
    await change('notes', 'Correction après réponse perdue'); await submit(run);
    expect(run.outcomes).toEqual([false, false]); expect(calls('create_record')).toHaveLength(1); expect(stored(kind).value.notes).toBe('Correction après réponse perdue');
  });
  it('retains committed-but-unacknowledged creation for human comparison instead of false success', async () => {
    const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind); commitThenLoseReply = true;
    await submit(run); expect(run.outcomes).toEqual([false]); expect(rows[kind].size).toBe(1); expect(stored(kind).value.creationId).toMatch(uuid);
    const alert = form().querySelector('[data-contact-creation-recovery]'); expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.closest('details, [hidden], [aria-hidden="true"]')).toBeNull();
  });
  it('retries an absent refused creation after restart with the corrected fields and original UUID', async () => {
    let run = executor(); const view = await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind);
    const id = stored(kind).value.creationId; rejectCreate = true; await submit(run); expect(run.outcomes).toEqual([false]);
    await unmount(view); vi.resetModules(); runtime = await loadRuntime(); run = executor();
    await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await click('Reprendre ma saisie');
    await change('notes', 'Correction conservée après redémarrage'); rejectCreate = false; await submit(run);
    expect(calls('create_record')).toHaveLength(2); expect(calls('create_record').map(call => call[1].data.id)).toEqual([id, id]);
    expect(rows[kind].get(id)?.notes).toBe('Correction conservée après redémarrage'); expect(run.outcomes).toEqual([true]);
  });
  it('allows intentionally new identical contacts after closing with distinct creation identities', async () => {
    const first = executor(); const view = await mount(kind, await runtime.desktopApi.loadWorkspace(), first); await fill(kind); await submit(first);
    await unmount(view); const second = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), second); await fill(kind); await submit(second);
    const ids = calls('create_record').map(call => call[1].data.id); expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
    expect(first.outcomes).toEqual([true]); expect(second.outcomes).toEqual([true]);
  });
  it('preserves ordinary edit without a new creation UUID', async () => {
    const id = crypto.randomUUID(); rows[kind].set(id, { id, name: fields[kind].name || fields[kind].company, ...fields[kind], payment_terms_days: 30, address_line1: fields[kind].street, postal_code: fields[kind].postalCode, contact_person: fields[kind].contactPerson });
    const workspace = await runtime.desktopApi.loadWorkspace(); const item = workspace[entity(kind)][0] as Client | Supplier;
    const run = executor(); await mount(kind, workspace, run, item); await change('notes', 'Modification existante');
    expect(stored(kind, id).value).not.toHaveProperty('creationId'); await submit(run);
    expect(calls('create_record')).toHaveLength(0); expect(calls('update_record')).toHaveLength(1);
    expect(calls('update_record')[0][1]).toMatchObject({ id, expectedWorkspaceScope: companyId }); expect(run.outcomes).toEqual([true]);
  });
  it('blocks missing identity scope even through a forced submit', async () => {
    const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run, undefined, { memberId, ready: false });
    for (const [name, value] of Object.entries(fields[kind])) setBrowserValue(name, value);
    await submit(run, false); expect(calls('create_record')).toHaveLength(0);
  });
  it('preserves read-only prohibition even through forced submit and legacy preparation', async () => {
    seed(kind, fields[kind]); const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run, undefined, { memberId, ready: true }, true);
    await submit(run, false); expect(calls('create_record')).toHaveLength(0); expect(form().textContent).not.toContain('Préparer une nouvelle fiche');
  });
  it('rejects a destination workspace returned by preflight without issuing a creation', async () => {
    const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind);
    readScope = 'another-synthetic-company'; await submit(run); expect(run.outcomes).toEqual([false]); expect(calls('create_record')).toHaveLength(0); expect(stored(kind).value.creationId).toMatch(uuid);
  });
});

// Post-review regressions: real language hook, native-field adapter and reset
// result. Synthetic Storage and IPC only; no live server or parent claim.
describe.each(['client', 'supplier'] as const)('reviewed contact recovery %s', kind => {
  it.each(['fr', 'de', 'it', 'en'] as const)('keeps local capture guidance after choosing %s and never resends on local retry', async language => {
    const run = executor(); await mount(kind, await runtime.desktopApi.loadWorkspace(), run); await fill(kind);
    const creationId = stored(kind).value.creationId;
    storage.captureFailureKey = key(kind); setBrowserValue('notes', 'Final local-only correction');
    await submit(run, false); expect(calls('create_record')).toHaveLength(0);
    expect(form().querySelector('[data-contact-storage-recovery]')).not.toBeNull();
    // Pack loading follows the real hook; the response is an in-memory local
    // asset adapter. It cannot make any network request.
    const fetchPack = vi.fn(async () => ({ ok: true, json: async () => ({ 'Synthetic local pack': 'Local language fixture' }) }));
    vi.stubGlobal('fetch', fetchPack);
    const appLanguage = await import('./language');
    await runtime.react.act(async () => { expect(await appLanguage.setAppLanguage(language)).toBe(true); });
    const guidance = form().querySelector('[data-contact-storage-recovery]');
    const expected = {
      fr: 'Cette nouvelle fiche ne peut pas être conservée sur cet appareil.',
      de: 'Dieser neue Kontakt kann auf diesem Gerät nicht gespeichert werden.',
      it: 'Questa nuova scheda non può essere conservata sul dispositivo.',
      en: 'This new contact cannot be retained on this device.',
    }[language];
    expect(guidance?.textContent).toContain(expected);
    const { userErrorCopy } = await import('./userErrors');
    expect(form().querySelector('.contact-form-failure')?.textContent).not.toContain(userErrorCopy(language).unknown.message);
    expect(calls('create_record')).toHaveLength(0); expect(stored(kind).value.creationId).toBe(creationId);
    expect(fetchPack).toHaveBeenCalledTimes(language === 'fr' ? 0 : 1);
    storage.captureFailureKey = null;
    const retry = form().querySelector<HTMLButtonElement>('.contact-form-failure .error-guidance__actions button');
    expect(retry).not.toBeNull(); await runtime.react.act(async () => retry!.click());
    expect(calls('create_record')).toHaveLength(0); expect(form().querySelector('[data-contact-storage-recovery]')).toBeNull();
    expect(stored(kind).value.notes).toBe('Final local-only correction'); expect(stored(kind).value.creationId).toBe(creationId);
    await submit(run); expect(calls('create_record')).toHaveLength(1); expect(calls('create_record')[0][1].data.id).toBe(creationId);
  });
  it.each(['throws', 'silent-removal', 'readback-throws'] as const)('does not close an invalid initially-clean draft when discard %s', async mode => {
    seed(kind, { ...fields[kind], creationId: 'malformed-review-identity' });
    const raw = storage.getItem(key(kind)); const run = executor(), closed = vi.fn();
    await mount(kind, await runtime.desktopApi.loadWorkspace(), run, undefined, undefined, false, closed);
    expect(form().textContent).toContain('Ce brouillon ne peut plus être repris');
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    if (mode === 'throws') storage.retireKey = key(kind);
    if (mode === 'silent-removal') {
      const remove = storage.removeItem.bind(storage);
      spy = vi.spyOn(storage, 'removeItem').mockImplementation(name => { if (name !== key(kind)) remove(name); });
    }
    if (mode === 'readback-throws') {
      const get = storage.getItem.bind(storage);
      let afterRemoval = false;
      const remove = storage.removeItem.bind(storage);
      vi.spyOn(storage, 'removeItem').mockImplementation(name => { remove(name); if (name === key(kind)) afterRemoval = true; });
      spy = vi.spyOn(storage, 'getItem').mockImplementation(name => { if (name === key(kind) && afterRemoval) throw new DOMException('Readback blocked', 'SecurityError'); return get(name); });
    }
    await click('Abandonner le brouillon'); confirmation.mockRestore(); spy?.mockRestore();
    expect(closed).not.toHaveBeenCalled(); expect(calls('create_record')).toHaveLength(0);
    // A thrown readback leaves the result unknown even if deletion happened;
    // neither callback nor UI may claim verified discard or close the form.
    if (mode !== 'readback-throws') expect(storage.getItem(key(kind))).toBe(raw);
    expect(form().querySelector('.form-draft-notice')?.textContent).toContain('La saisie locale ne peut pas être conservée');
  });
  it('keeps an edit modal open and restores stored values after successful discard', async () => {
    const id = crypto.randomUUID();
    rows[kind].set(id, { id, name: fields[kind].name || fields[kind].company, ...fields[kind], payment_terms_days: 30, address_line1: fields[kind].street, postal_code: fields[kind].postalCode, contact_person: fields[kind].contactPerson });
    const workspace = await runtime.desktopApi.loadWorkspace(); const item = workspace[entity(kind)][0] as Client | Supplier;
    const run = executor(), closed = vi.fn(); await mount(kind, workspace, run, item, undefined, false, closed); await change('notes', 'Unsaved correction');
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(true); await click('Abandonner le brouillon'); confirmation.mockRestore();
    expect(closed).not.toHaveBeenCalled(); expect(field('notes').value).toBe(fields[kind].notes); expect(storage.getItem(key(kind, id))).toBeNull();
    expect(form().querySelector('.form-draft-notice')).toBeNull(); expect(calls('create_record')).toHaveLength(0); expect(calls('update_record')).toHaveLength(0);
  });
});
