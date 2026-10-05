import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './types';

// Actual component/App JSX and bridge; only hooks, presentation and a closed
// deferred diagnostic transport are substituted. No native/API operation runs.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.state(...args),
  useRef: (...args: any[]) => runtime.host.ref(...args),
  useMemo: (...args: any[]) => runtime.host.memo(...args),
  useCallback: (...args: any[]) => runtime.host.memo(() => args[0], args[1]),
  useEffect: (action: any, deps: any) => runtime.host.effect(action, deps, 'passive'),
  useLayoutEffect: (action: any, deps: any) => runtime.host.effect(action, deps, 'layout'),
}));
vi.mock('./diagnostics', async original => ({ ...await original<typeof import('./diagnostics')>(), diagnosticInvoke: runtime.invoke, recordDiagnostic: () => 'synthetic-incident', classifyDiagnosticError: () => 'SYNTHETIC' }));
vi.mock('./language', () => ({ t: (value: string) => value, useAppLanguage: () => 'fr', getAppLocale: () => 'fr-CH' }));
vi.mock('./ui', () => ({ Button: () => null, ErrorPanel: () => null, Modal: () => null, Field: () => null }));
vi.mock('./useMobileLayout', () => ({ useMobileLayout() {} }));
vi.mock('./appOpening', async original => ({
  ...await original<typeof import('./appOpening')>(),
  waitForNativeStartup: async () => {},
  withinAppOpeningDeadline: (request: Promise<unknown>) => request,
}));
vi.mock('./WorkspaceApp', () => ({ WorkspaceApp: () => null }));
vi.mock('./Onboarding', () => ({ Onboarding: () => null }));
vi.mock('./AppUpdater', () => ({ AppUpdater: () => null }));
vi.mock('./DevelopmentNotice', () => ({ DevelopmentNotice: () => null }));
vi.mock('./CloudAccountAccess', () => ({ CloudAccountAccess: () => null }));
vi.mock('./ErrorGuidance', () => ({ ErrorGuidance: () => null }));
vi.mock('./BrandMark', () => ({ BrandMark: () => null }));
// Existing closed Host now supplies the same admitted identity that real App provides.
vi.mock('./useFormDraft', () => ({ FormDraftIdentityProvider: () => null, useFormDraftIdentity: () => ({companyId:runtime.host.props.workspace?.workNotesScope ?? 'synthetic-profile-scope-a',memberId:'synthetic-member',memberContextNonce:'0123456789abcdef0123456789abcdef',ready:true}) }));
import { App } from './App';
import { BusinessProfileGate, BusinessProfileFields } from './BusinessProfileEditor';
import { CompanyAccountGate } from './CompanyAccountGate';
import { desktopApi } from './bridge';
import { Button, ErrorPanel } from './ui';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

type Element = { type: unknown; key?: string; props: Record<string, any> };
class Host {
  slots: any[] = []; index = 0; dirty = false; mounted = true; tree: unknown;
  effects: Array<() => void> = []; writes: unknown[] = []; unmountedWrites = 0;
  admittedMarker = '';
  constructor(public component: (props: any) => unknown, public props: any) { this.render(); }
  state(initial: any) {
    const slot = this.slots[this.index++] ??= { value: typeof initial === 'function' ? initial() : initial };
    slot.setter ??= (value: any) => {
      if (!this.mounted) this.unmountedWrites++;
      this.writes.push(value); const next = typeof value === 'function' ? value(slot.value) : value;
      if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true; }
    };
    return [slot.value, slot.setter];
  }
  ref(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
  memo(factory: () => unknown, deps: unknown[]) {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.slots[index] = { deps, value: factory() };
    return this.slots[index].value;
  }
  effect(action: () => (() => void) | void, deps: unknown[], kind: 'layout' | 'passive') {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.effects.push(() => {
      previous?.cleanup?.(); this.slots[index] = { deps, kind, cleanup: action() };
    });
  }
  render(props = this.props) {
    this.props = props; this.index = 0; this.dirty = false; this.effects = []; runtime.host = this;
    this.tree = this.component(props); for (const action of this.effects) action();
    // This Host does not mount child components. Deliver the existing real
    // marker contract; separate ReactDOM tests prove its actual lifecycle.
    const marker = nodes(this.tree).find(node => typeof node.type === 'function' && (node.type as Function).name === 'DraftCompanyAdmissionMarker');
    if (marker) { const admission = JSON.stringify([marker.props.identityKey, marker.props.epoch]); if (this.admittedMarker !== admission) { this.admittedMarker = admission; marker.props.onAdmission({key:marker.props.identityKey,epoch:marker.props.epoch}); } }
    this.flush();
  }
  flush() { if (this.mounted && this.dirty) this.render(); }
  unmount() { for (const slot of this.slots) slot.cleanup?.(); this.mounted = false; }
  unmountLayoutOnly() { for (const slot of this.slots) if (slot.kind === 'layout') slot.cleanup?.(); this.mounted = false; }
}
function nodes(tree: unknown): Element[] {
  return Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Element, ...nodes((tree as Element).props?.children)];
}
function text(tree: unknown): string {
  return Array.isArray(tree) ? tree.map(text).join('') : !tree || typeof tree === 'boolean' ? '' : typeof tree === 'object' ? text((tree as Element).props?.children) : String(tree);
}
function one(host: Host, predicate: (element: Element) => boolean) {
  const matches = nodes(host.tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}
const form = (host: Host) => one(host, node => node.type === 'form');
const button = (host: Host) => one(host, node => node.type === Button && node.props.type === 'submit');
const fields = (host: Host) => one(host, node => node.type === BusinessProfileFields);
const message = (host: Host) => nodes(host.tree).find(node => node.type === ErrorPanel)?.props.message ?? '';
const submit = (host: Host) => form(host).props.onSubmit({ preventDefault() {} });
async function settle(host?: Host) { for (let n = 0; n < 50; n++) { await Promise.resolve(); host?.flush(); } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const scope = 'synthetic-profile-scope-a', otherScope = 'synthetic-profile-scope-b';
function rawWorkspace(origin = scope) {
  return { work_notes_scope: origin, settings: { company_name: 'Synthetic same company name', payment_terms_days: 30,
    uid_number: 'CHE-SYNTHETIC', noga_section: 'J', noga_division: '62', activity_description: 'Synthetic initial activity', noga_detailed_code: '',
    extra_settings_json: JSON.stringify({ payroll: { accidentInsurer: 'Synthetic unchanged insurer' } }) } };
}
async function setup() {
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: globalThis.setTimeout });
  let initialRead = true;
  const reads: ReturnType<typeof deferred<ReturnType<typeof rawWorkspace>>>[] = [];
  const mutations: Array<ReturnType<typeof deferred<void>> & { args: any }> = [];
  const license = { status: 'valid', access_role: 'owner', read_only: false, enforcement_configured: false, can_refresh: false };
  runtime.invoke.mockImplementation((command: string, args: any) => {
    if (command === 'get_form_draft_identity') return Promise.resolve({memberId:'synthetic-member',memberContextNonce:'0123456789abcdef0123456789abcdef'});
    if (command === 'get_app_state') return Promise.resolve({ onboarding_completed: 1, activity_profile_required: 1 });
    if (command === 'get_workspace') {
      if (initialRead) { initialRead = false; return Promise.resolve(rawWorkspace()); }
      const task = deferred<ReturnType<typeof rawWorkspace>>(); reads.push(task); return task.promise;
    }
    if (command === 'update_settings') { const task = deferred<void>(); mutations.push({ ...task, args }); return task.promise; }
    if (command === 'get_cached_cloud_account_state' || command === 'get_cloud_account_state') return Promise.resolve({ status: 'disconnected' });
    if (command === 'get_license_state') return Promise.resolve(license);
    throw Error(`Unexpected native/API command: ${command}`);
  });
  const workspace = await desktopApi.loadWorkspace(), publish = vi.fn();
  const host = new Host(BusinessProfileGate, { workspace, readOnly: false, onSaved: publish });
  fields(host).props.onChange({ ...fields(host).props.profile, activityDescription: '  Synthetic chosen activity  ' }); host.flush();
  return { host, workspace, publish, reads, mutations, license };
}
function leave(host: Host, kind: 'unmount' | 'scope' | 'readOnly' | 'layout') {
  if (kind === 'unmount') host.unmount();
  else if (kind === 'layout') host.unmountLayoutOnly();
  else if (kind === 'scope') host.render({ ...host.props, workspace: { ...host.props.workspace, workNotesScope: otherScope } });
  else host.render({ ...host.props, readOnly: true });
}
async function confirm(fixture: Awaited<ReturnType<typeof setup>>) {
  fixture.mutations[0].resolve(); await settle(fixture.host); fixture.reads[0].resolve(rawWorkspace()); await settle(fixture.host);
}
afterEach(() => { runtime.invoke.mockReset(); runtime.host = null; vi.unstubAllGlobals(); });

describe('business activity gate lifecycle through actual component and bridge', () => {
  it('sends the full unchanged settings and trimmed choice in one scoped mutation with one refresh', async () => {
    const fixture = await setup(), { host, reads, mutations, publish } = fixture;
    submit(host); await settle(host); expect(mutations).toHaveLength(1); expect(reads).toHaveLength(0);
    expect(mutations[0].args.expectedWorkspaceScope).toBe(scope);
    expect(mutations[0].args.data).toMatchObject({ company_name: 'Synthetic same company name', uid_number: 'CHE-SYNTHETIC', payment_terms_days: 30,
      noga_section: 'J', noga_division: '62', activity_description: 'Synthetic chosen activity' });
    expect(JSON.parse(mutations[0].args.data.extra_settings_json).payroll.accidentInsurer).toBe('Synthetic unchanged insurer');
    await confirm(fixture); expect(publish).toHaveBeenCalledTimes(1); expect(publish.mock.calls[0][0].workNotesScope).toBe(scope);
    expect(mutations).toHaveLength(1); expect(reads).toHaveLength(1); expect(text(host.tree)).not.toContain('Enregistrement…');
  });

  it('locks a captured submit handler synchronously before its first await', async () => {
    const fixture = await setup(), { host, mutations, publish } = fixture, handler = form(host).props.onSubmit;
    handler({ preventDefault() {} }); handler({ preventDefault() {} }); await settle(host); expect(mutations).toHaveLength(1);
    await confirm(fixture); expect(publish).toHaveBeenCalledTimes(1);
  });

  it('uses the current same-scope settings and choice when an older handler is retained before dispatch', async () => {
    const fixture = await setup(), { host, mutations } = fixture, handler = form(host).props.onSubmit;
    host.render({ ...host.props, workspace: { ...host.props.workspace, settings: { ...host.props.workspace.settings, organization: { ...host.props.workspace.settings.organization, uidNumber: 'CHE-SYNTHETIC-FRESH' } } } });
    fields(host).props.onChange({ ...fields(host).props.profile, activityDescription: 'Synthetic most recent choice' }); host.flush();
    handler({ preventDefault() {} }); await settle(host);
    expect(mutations[0].args.data).toMatchObject({ uid_number: 'CHE-SYNTHETIC-FRESH', activity_description: 'Synthetic most recent choice' });
    await confirm(fixture);
  });

  it('explains read-only admission without dispatching a mutation', async () => {
    const { host, mutations } = await setup(); leave(host, 'readOnly'); submit(host); await settle(host);
    expect(text(host.tree)).toContain('Mode lecture seule : les modifications ne peuvent pas être enregistrées.');
    expect(button(host).props.disabled).toBe(true); expect(mutations).toHaveLength(0);
  });

  it.each([undefined, ''])('explains an unidentified physical scope %s and never writes without it', async missingScope => {
    const { host, mutations } = await setup(); host.unmount();
    const unidentified = new Host(BusinessProfileGate, { ...host.props, workspace: { ...host.props.workspace, workNotesScope: missingScope } });
    submit(unidentified); await settle(unidentified); expect(message(unidentified)).toBe('L’espace local n’a pas pu être ouvert.');
    expect(button(unidentified).props.disabled).toBe(true); expect(mutations).toHaveLength(0);
  });

  it.each(['unmount', 'scope', 'readOnly', 'layout', 'missingScope', 'emptyScope'] as const)('refuses a retained writable handler after %s before dispatch', async kind => {
    const { host, mutations, reads, publish } = await setup(), handler = form(host).props.onSubmit;
    if (kind === 'missingScope' || kind === 'emptyScope') host.render({ ...host.props, workspace: { ...host.props.workspace, workNotesScope: kind === 'emptyScope' ? '' : undefined } });
    else leave(host, kind);
    const writes = host.writes.length; handler({ preventDefault() {} }); await settle(host);
    expect(mutations).toHaveLength(0); expect(reads).toHaveLength(0); expect(publish).not.toHaveBeenCalled();
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });

  it.each(['mutation', 'refresh'] as const)('suppresses success after unmount during %s', async stage => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture; submit(host); await settle(host);
    if (stage === 'mutation') host.unmount(); mutations[0].resolve(); await settle(host);
    if (stage === 'refresh') host.unmount(); const writes = host.writes.length; reads[0].resolve(rawWorkspace()); await settle(host);
    expect(publish).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(mutations).toHaveLength(1);
  });

  it.each(['mutation', 'refresh'] as const)('suppresses success after a same-name physical scope change during %s', async stage => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture; submit(host); await settle(host);
    if (stage === 'mutation') leave(host, 'scope'); mutations[0].resolve(); await settle(host);
    if (stage === 'refresh') leave(host, 'scope'); const writes = host.writes.length; reads[0].resolve(rawWorkspace()); await settle(host);
    expect(publish).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes); expect(mutations).toHaveLength(1);
  });

  it.each(['mutation', 'refresh'] as const)('closes the layout cleanup window before passive cleanup during %s', async stage => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture; submit(host); await settle(host);
    if (stage === 'refresh') { mutations[0].resolve(); await settle(host); }
    host.unmountLayoutOnly(); const writes = host.writes.length;
    if (stage === 'mutation') { mutations[0].resolve(); await settle(host); }
    reads[0].resolve(rawWorkspace()); await settle(host);
    expect(publish).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });

  it.each(['unmount', 'scope', 'layout'] as const)('suppresses native refusal after %s', async kind => {
    const { host, mutations, reads, publish } = await setup(); submit(host); await settle(host); leave(host, kind); const writes = host.writes.length;
    mutations[0].reject(new Error('Synthetic original native refusal')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(publish).not.toHaveBeenCalled(); expect(reads).toHaveLength(0);
  });

  it.each(['unmount', 'scope', 'layout'] as const)('suppresses refresh refusal after %s without replay', async kind => {
    const { host, mutations, reads, publish } = await setup(); submit(host); await settle(host); mutations[0].resolve(); await settle(host);
    leave(host, kind); const writes = host.writes.length; reads[0].reject(new Error('Synthetic late refresh refusal')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(publish).not.toHaveBeenCalled(); expect(mutations).toHaveLength(1);
  });

  it('can publish an already dispatched confirmation in the origin after read-only changes and clears busy', async () => {
    const fixture = await setup(), { host, mutations, publish } = fixture; submit(host); await settle(host); leave(host, 'readOnly');
    await confirm(fixture); expect(publish).toHaveBeenCalledTimes(1); expect(mutations).toHaveLength(1);
    expect(text(host.tree)).not.toContain('Enregistrement…'); expect(button(host).props.disabled).toBe(true); expect(fields(host).props.disabled).toBe(true);
  });

  it('preserves the original refusal and choice while read-only and allows only a later explicit retry', async () => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture; submit(host); await settle(host); leave(host, 'readOnly');
    const reason = new Error('Synthetic original native refusal'); mutations[0].reject(reason); await settle(host);
    expect(message(host)).toBe(reason.message); expect(text(host.tree)).not.toContain('Enregistrement…'); expect(publish).not.toHaveBeenCalled();
    expect(fields(host).props.profile.activityDescription).toBe('  Synthetic chosen activity  '); expect(reads).toHaveLength(0);
    const handler = form(host).props.onSubmit; handler({ preventDefault() {} }); await settle(host); expect(mutations).toHaveLength(1);
    host.render({ ...host.props, readOnly: false }); submit(host); await settle(host); expect(mutations).toHaveLength(2);
    mutations[1].resolve(); await settle(host); reads[0].resolve(rawWorkspace()); await settle(host); expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['rejection', 'wrongScope'] as const)('reports a confirmed write if refresh returns %s and keeps the choice without replay', async kind => {
    const { host, mutations, reads, publish } = await setup(); submit(host); await settle(host); mutations[0].resolve(); await settle(host);
    if (kind === 'rejection') reads[0].reject(new Error('Synthetic refresh unavailable')); else reads[0].resolve(rawWorkspace(otherScope));
    await settle(host); expect(message(host)).toMatch(/enregistrée.*actualisation/); expect(publish).not.toHaveBeenCalled(); expect(mutations).toHaveLength(1);
    expect(fields(host).props.profile.activityDescription).toBe('  Synthetic chosen activity  '); expect(text(host.tree)).not.toContain('Enregistrement…');
  });

  it('preserves the bridge confirmed-write error type on a wrong-scope response', async () => {
    const { workspace, mutations, reads } = await setup(); const task = desktopApi.saveSettings(workspace.settings!, scope);
    await settle(); mutations[0].resolve(); await settle(); reads[0].resolve(rawWorkspace(otherScope));
    await expect(task).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
  });

  it('uses the latest onSaved callback in the unchanged origin and keeps the chosen profile across fresh props', async () => {
    const fixture = await setup(), { host, publish, mutations } = fixture; submit(host); await settle(host);
    const latest = vi.fn(); host.render({ ...host.props, workspace: { ...host.props.workspace }, onSaved: latest });
    expect(fields(host).props.profile.activityDescription).toBe('  Synthetic chosen activity  ');
    await confirm(fixture); expect(publish).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledTimes(1); expect(mutations).toHaveLength(1);
  });

  it.each(['unmount', 'scope'] as const)('does not publish an orphan busy state when the callback causes %s', async kind => {
    const fixture = await setup(), { host, publish } = fixture; publish.mockImplementation(() => leave(host, kind));
    submit(host); await settle(host); const writes = host.writes.length; await confirm(fixture);
    expect(publish).toHaveBeenCalledTimes(1); expect(host.unmountedWrites).toBe(0); expect(host.writes).toHaveLength(writes);
  });

  it('retains validProfile checks without dispatching invalid activity choices', async () => {
    const { host, mutations, publish } = await setup(); fields(host).props.onChange({ ...fields(host).props.profile, nogaDivision: '6' }); host.flush();
    submit(host); await settle(host); expect(mutations).toHaveLength(0); expect(publish).not.toHaveBeenCalled(); expect(message(host)).toContain('section et une division officielles');
  });
});

describe('actual App business profile admission JSX', () => {
  async function openApp(readOnly = false) {
    const fixture = await setup(); fixture.host.unmount(); fixture.license.read_only = readOnly;
    const app = new Host(App, {}); await settle(app); expect(fixture.reads).toHaveLength(1);
    fixture.reads[0].resolve(rawWorkspace()); await settle(app);
    return { ...fixture, app, gate: () => one(app, node => node.type === BusinessProfileGate), parent: () => one(app, node => node.type === CompanyAccountGate) };
  }
  it('keys a new gate by physical scope even when the company name remains the same', async () => {
    const { app, gate, parent, workspace } = await openApp(); const original = gate().key;
    expect(original).toBe(scope); parent().props.onWorkspace({ ...workspace }); app.flush(); expect(gate().key).toBe(original);
    const received = { ...workspace, workNotesScope: otherScope, settings: { ...workspace.settings!, business: { ...workspace.settings!.business, activityDescription: 'Synthetic received activity B' } } };
    parent().props.onWorkspace(received); app.flush(); await settle(app); expect(gate().key).toBe(otherScope); expect(gate().key).not.toBe(original);
    const renewed = new Host(gate().type as (props: any) => unknown, gate().props);
    expect(fields(renewed).props.profile).toEqual(received.settings.business);
  });
  it('passes licence read-only admission to the business profile gate', async () => {
    const { gate } = await openApp(true); expect(gate().props.readOnly).toBe(true);
  });
  it('passes a current read-only cloud role to the business profile gate', async () => {
    const { app, gate, parent } = await openApp(); expect(gate().props.readOnly).toBe(false);
    parent().props.onAccountChange({ status: 'connected', organizationId: 'synthetic-org-a', role: 'read_only' }); await settle(app);
    expect(gate().props.readOnly).toBe(true);
  });
});
