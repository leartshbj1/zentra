import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './types';

// The actual overview renders its private configuration component. The actual
// bridge runs against closed, deferred diagnostic transport; no native/API I/O.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.state(...args),
  useRef: (...args: any[]) => runtime.host.ref(...args),
  useEffect: (action: any, deps: any) => runtime.host.effect(action, deps, 'passive'),
  useLayoutEffect: (action: any, deps: any) => runtime.host.effect(action, deps, 'layout'),
}));
vi.mock('./diagnostics', async original => ({ ...await original<typeof import('./diagnostics')>(), diagnosticInvoke: runtime.invoke }));
vi.mock('./language', () => ({ t: (value: string) => value, useAppLanguage: () => {}, getAppLocale: () => 'fr-CH' }));
vi.mock('./MobileDetails', () => ({ useCompactLayout: () => false, MobileDetails: () => null }));
vi.mock('./FinanceFirstStep', () => ({ FinanceFirstStep: () => null }));
vi.mock('./ui', () => ({ Button: () => null, ErrorPanel: () => null, Modal: () => null }));
import { FinanceOverview } from './FinanceOverview';
import { desktopApi } from './bridge';
import { Button, ErrorPanel } from './ui';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

type Props = Parameters<typeof FinanceOverview>[0];
type Element = { type: unknown; props: Record<string, any> };
class Host {
  slots: any[] = []; index = 0; dirty = false; mounted = true;
  effects: Array<() => void> = []; tree: unknown; writes: unknown[] = []; unmountedWrites = 0;
  constructor(public component: (props: any) => unknown, public props: any) { this.render(); }
  state(initial: any) {
    const slot = this.slots[this.index++] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slot.value, (value: any) => {
      if (!this.mounted) this.unmountedWrites++;
      this.writes.push(value); const next = typeof value === 'function' ? value(slot.value) : value;
      if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true; }
    }];
  }
  ref(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
  effect(action: () => (() => void) | void, deps: unknown[], kind: 'layout' | 'passive') {
    const index = this.index++, previous = this.slots[index];
    if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) this.effects.push(() => {
      previous?.cleanup?.(); this.slots[index] = { deps, kind, cleanup: action() };
    });
  }
  render(props = this.props) {
    this.props = props; this.index = 0; this.dirty = false; this.effects = []; runtime.host = this;
    this.tree = this.component(props); for (const action of this.effects) action(); this.flush();
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
const button = (host: Host, label: string) => one(host, node => node.type === Button && text(node).includes(label));
const message = (host: Host) => nodes(host.tree).find(node => node.type === ErrorPanel)?.props.message ?? '';
async function settle(host?: Host) { for (let n = 0; n < 30; n++) { await Promise.resolve(); host?.flush(); } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const scope = 'synthetic-finance-scope-a';
function rawWorkspace(origin = scope) {
  return { work_notes_scope: origin, settings: { company_name: 'Synthetic same company name', payment_terms_days: 30,
    uid_number: 'CHE-SYNTHETIC', vat_registered: 1, extra_settings_json: JSON.stringify({
      payroll: { enabled: true, accidentInsurer: 'Synthetic unchanged insurer' },
    }) } };
}
async function setup() {
  let initialRead = true;
  const reads: ReturnType<typeof deferred<ReturnType<typeof rawWorkspace>>>[] = [];
  const mutations: Array<ReturnType<typeof deferred<void>> & { args: any }> = [];
  runtime.invoke.mockImplementation((command: string, args: any) => {
    if (command === 'get_app_state') return Promise.resolve({ onboarding_completed: 1 });
    if (command === 'get_workspace') {
      if (initialRead) { initialRead = false; return Promise.resolve(rawWorkspace()); }
      const task = deferred<ReturnType<typeof rawWorkspace>>(); reads.push(task); return task.promise;
    }
    if (command === 'update_settings') { const task = deferred<void>(); mutations.push({ ...task, args }); return task.promise; }
    throw Error(`Unexpected native/API command: ${command}`);
  });
  const workspace = await desktopApi.loadWorkspace(), publish = vi.fn();
  const outer = new Host(FinanceOverview, { workspace, income: null, continuity: { enabled: true, mappingReady: true, journalEntryCount: 1, starterAvailable: true },
    busy: false, periodLabel: 'Synthetic period', readOnly: false, onSection: vi.fn(), onInstallStarter: vi.fn(async () => {}), onWorkspaceChange: publish } as unknown as Props);
  button(outer, 'Configurer simplement').props.onClick(); outer.flush();
  const configuration = one(outer, node => typeof node.type === 'function' && (node.type as Function).name === 'FinanceConfiguration');
  const host = new Host(configuration.type as (props: any) => unknown, configuration.props);
  one(host, node => node.type === 'input' && node.props.value === 'short').props.onChange(); host.flush();
  button(host, 'Vérifier mes choix').props.onClick(); host.flush();
  return { outer, host, publish, reads, mutations };
}
function leave(host: Host, kind: 'unmount' | 'scope' | 'readOnly') {
  if (kind === 'unmount') host.unmount();
  else if (kind === 'scope') host.render({ ...host.props, workspace: { ...host.props.workspace, workNotesScope: 'synthetic-finance-scope-b' } });
  else host.render({ ...host.props, readOnly: true });
}
async function reachMutation(fixture: Awaited<ReturnType<typeof setup>>) {
  fixture.reads[0].resolve(rawWorkspace()); await settle(fixture.host); expect(fixture.mutations).toHaveLength(1);
}
afterEach(() => { runtime.invoke.mockReset(); runtime.host = null; });

describe('finance configuration lifecycle through actual rendered component and bridge', () => {
  it('preserves the chosen preset and unrelated fresh settings with one scoped save', async () => {
    const fixture = await setup(), { host, publish, reads, mutations } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host);
    const fresh = rawWorkspace(); fresh.settings.uid_number = 'CHE-SYNTHETIC-FRESH'; reads[0].resolve(fresh); await settle(host);
    expect(mutations).toHaveLength(1); expect(mutations[0].args.expectedWorkspaceScope).toBe(scope);
    expect(mutations[0].args.data).toMatchObject({ uid_number: fresh.settings.uid_number, payment_terms_days: 14, vat_registered: true });
    expect(JSON.parse(mutations[0].args.data.extra_settings_json).payroll.accidentInsurer).toBe('Synthetic unchanged insurer');
    mutations[0].resolve(); await settle(host); expect(reads).toHaveLength(2); reads[1].resolve(rawWorkspace()); await settle(host);
    expect(publish).toHaveBeenCalledTimes(1); expect((publish.mock.calls[0][0] as Workspace).workNotesScope).toBe(scope);
    expect((host.tree as Element).props.title).toBe('Votre configuration est enregistrée'); expect(mutations).toHaveLength(1);
  });

  it('locks repeated submissions synchronously', async () => {
    const fixture = await setup(), { host, reads, mutations } = fixture; const handler = button(host, 'Appliquer ces réglages').props.onClick;
    handler(); handler(); await settle(host); expect(reads).toHaveLength(1); await reachMutation(fixture);
    mutations[0].resolve(); await settle(host); reads[1].resolve(rawWorkspace()); await settle(host); expect(mutations).toHaveLength(1);
  });

  it.each(['unmount', 'scope', 'readOnly'] as const)('does not dispatch after %s during preflight', async kind => {
    const { host, reads, mutations, publish } = await setup(); button(host, 'Appliquer ces réglages').props.onClick(); await settle(host);
    leave(host, kind); const writes = host.writes.length; reads[0].resolve(rawWorkspace()); await settle(host);
    expect(mutations).toHaveLength(0); expect(publish).not.toHaveBeenCalled(); expect(host.unmountedWrites).toBe(0);
    if (kind !== 'readOnly') expect(host.writes).toHaveLength(writes);
    else { expect(button(host, 'Appliquer ces réglages').props.disabled).toBe(true); expect(text(host.tree)).not.toContain('Enregistrement…'); }
  });

  it('rejects another physical scope in the preflight response even when the component did not rerender', async () => {
    const { host, reads, mutations, publish } = await setup(); button(host, 'Appliquer ces réglages').props.onClick(); await settle(host);
    reads[0].resolve(rawWorkspace('synthetic-finance-scope-b')); await settle(host);
    expect(mutations).toHaveLength(0); expect(publish).not.toHaveBeenCalled();
    expect(message(host)).toBe('L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace. Vos choix sont conservés.');
    expect(button(host, 'Appliquer ces réglages').props.disabled).toBe(false);
  });

  it.each(['unmount', 'scope', 'readOnly', 'missingScope', 'emptyScope'] as const)('refuses the retained old handler after %s before starting a read', async kind => {
    const { host, reads, mutations } = await setup(); const handler = button(host, 'Appliquer ces réglages').props.onClick;
    if (kind === 'missingScope' || kind === 'emptyScope') host.render({ ...host.props, workspace: { ...host.props.workspace, workNotesScope: kind === 'emptyScope' ? '' : undefined } });
    else leave(host, kind);
    const writes = host.writes.length; handler(); await settle(host);
    expect(reads).toHaveLength(0); expect(mutations).toHaveLength(0); expect(host.writes).toHaveLength(writes);
  });

  it.each(['unmount', 'scope'] as const)('suppresses late read rejection after %s', async kind => {
    const { host, reads, mutations, publish } = await setup(); button(host, 'Appliquer ces réglages').props.onClick(); await settle(host);
    leave(host, kind); const writes = host.writes.length; reads[0].reject(new Error('Synthetic late preflight refusal')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(mutations).toHaveLength(0); expect(publish).not.toHaveBeenCalled();
  });

  it.each(['unmount', 'scope'] as const)('suppresses late native refusal after %s', async kind => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture); leave(host, kind); const writes = host.writes.length;
    mutations[0].reject(new Error('Synthetic late native refusal')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(reads).toHaveLength(1); expect(publish).not.toHaveBeenCalled();
  });

  it.each(['mutation', 'refresh'] as const)('does not publish confirmation after unmount during %s', async stage => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture);
    if (stage === 'mutation') host.unmount(); mutations[0].resolve(); await settle(host);
    if (stage === 'refresh') host.unmount(); const writes = host.writes.length; reads[1].resolve(rawWorkspace()); await settle(host);
    expect(publish).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });

  it('does not publish a confirmed result after the mounted component receives another scope', async () => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture); mutations[0].resolve(); await settle(host);
    leave(host, 'scope'); const writes = host.writes.length; reads[1].resolve(rawWorkspace()); await settle(host);
    expect(publish).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes);
  });

  it('clears busy on a mounted origin that becomes read-only, retaining the choice for a later explicit retry', async () => {
    const fixture = await setup(), { host, reads, mutations } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); leave(host, 'readOnly'); reads[0].resolve(rawWorkspace()); await settle(host);
    expect(mutations).toHaveLength(0); expect(text(host.tree)).not.toContain('Enregistrement…'); expect(text(host.tree)).toContain('14');
    host.render({ ...host.props, readOnly: false }); expect(button(host, 'Appliquer ces réglages').props.disabled).toBe(false);
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); expect(reads).toHaveLength(2);
    reads[1].resolve(rawWorkspace()); await settle(host); expect(mutations).toHaveLength(1); mutations[0].resolve(); await settle(host); reads[2].resolve(rawWorkspace()); await settle(host);
  });

  it('can publish an already dispatched write confirmed in the same origin after read-only admission changes', async () => {
    const fixture = await setup(), { host, reads, mutations, publish } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture); leave(host, 'readOnly');
    mutations[0].resolve(); await settle(host); reads[1].resolve(rawWorkspace()); await settle(host);
    expect(publish).toHaveBeenCalledTimes(1); expect((host.tree as Element).props.title).toBe('Votre configuration est enregistrée'); expect(text(host.tree)).not.toContain('Enregistrement…');
    expect(mutations).toHaveLength(1);
  });

  it('preserves native refusal and choice without automatic retry', async () => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture);
    const reason = new Error('Synthetic original native refusal'); mutations[0].reject(reason); await settle(host);
    expect(message(host)).toBe(reason.message); expect(publish).not.toHaveBeenCalled(); expect(mutations).toHaveLength(1); expect(reads).toHaveLength(1);
    expect(text(host.tree)).toContain('14'); expect(button(host, 'Appliquer ces réglages').props.disabled).toBe(false);
  });

  it.each(['rejection', 'wrongScope'] as const)('reports confirmation when only refresh returns %s without replaying the write', async kind => {
    const fixture = await setup(), { host, mutations, reads, publish } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture); mutations[0].resolve(); await settle(host);
    if (kind === 'rejection') reads[1].reject(new Error('Synthetic refresh unavailable'));
    else reads[1].resolve(rawWorkspace('synthetic-finance-scope-b'));
    await settle(host); expect(message(host)).toMatch(/enregistrée.*actualisation/); expect(publish).not.toHaveBeenCalled();
    expect(mutations).toHaveLength(1); expect(reads).toHaveLength(2); expect(button(host, 'Appliquer ces réglages').props.disabled).toBe(false);
  });

  it('preserves the bridge confirmed-write error type for a wrong-scope refresh', async () => {
    const { host, mutations, reads } = await setup(); const task = desktopApi.saveSettings(host.props.workspace.settings, scope);
    await settle(); expect(mutations[0].args.expectedWorkspaceScope).toBe(scope); mutations[0].resolve(); await settle();
    reads[0].resolve(rawWorkspace('synthetic-finance-scope-b')); await expect(task).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
  });

  it('does not write an orphan busy state after the publication callback unmounts the component', async () => {
    const fixture = await setup(), { host, publish, reads, mutations } = fixture; publish.mockImplementation(() => host.unmount());
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture); mutations[0].resolve(); await settle(host);
    reads[1].resolve(rawWorkspace()); await settle(host); expect(publish).toHaveBeenCalledTimes(1); expect(host.unmountedWrites).toBe(0);
  });

  it.each(['unmount', 'scope'] as const)('suppresses refresh failure after %s without replay', async kind => {
    const fixture = await setup(), { host, reads, mutations, publish } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture); mutations[0].resolve(); await settle(host);
    leave(host, kind); const writes = host.writes.length; reads[1].reject(new Error('Synthetic late refresh refusal')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(publish).not.toHaveBeenCalled(); expect(mutations).toHaveLength(1);
  });

  it('also clears busy if a preflight error reaches a mounted origin that became read-only', async () => {
    const { host, reads, mutations } = await setup(); button(host, 'Appliquer ces réglages').props.onClick(); await settle(host);
    leave(host, 'readOnly'); reads[0].reject(new Error('Synthetic current read refusal')); await settle(host);
    expect(message(host)).toBe('Synthetic current read refusal'); expect(text(host.tree)).not.toContain('Enregistrement…'); expect(mutations).toHaveLength(0);
    host.render({ ...host.props, readOnly: false }); expect(button(host, 'Appliquer ces réglages').props.disabled).toBe(false);
  });

  it('refuses a retained save handler after its first confirmed success', async () => {
    const fixture = await setup(), { host, reads, mutations } = fixture; const handler = button(host, 'Appliquer ces réglages').props.onClick;
    handler(); await settle(host); await reachMutation(fixture); mutations[0].resolve(); await settle(host); reads[1].resolve(rawWorkspace()); await settle(host);
    handler(); await settle(host); expect(reads).toHaveLength(2); expect(mutations).toHaveLength(1);
  });

  it.each(['unmount', 'scope'] as const)('guards the existing starter callback busy cleanup after %s', async kind => {
    const fixture = await setup(), { host, reads, mutations } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host); await reachMutation(fixture); mutations[0].resolve(); await settle(host);
    reads[1].resolve(rawWorkspace()); await settle(host); const completion = deferred<void>(), starter = vi.fn(() => completion.promise);
    host.render({ ...host.props, onInstallStarter: starter }); button(host, 'Préparer les comptes suisses').props.onClick(); await settle(host);
    expect(starter).toHaveBeenCalledTimes(1); leave(host, kind); const writes = host.writes.length;
    completion.resolve(); await settle(host); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(mutations).toHaveLength(1);
  });

  it.each(['preflight', 'mutation', 'refresh'] as const)('closes the layout cleanup window during %s before passive cleanup runs', async stage => {
    const fixture = await setup(), { host, reads, mutations, publish } = fixture;
    button(host, 'Appliquer ces réglages').props.onClick(); await settle(host);
    if (stage !== 'preflight') await reachMutation(fixture);
    if (stage === 'refresh') { mutations[0].resolve(); await settle(host); }
    host.unmountLayoutOnly(); const writes = host.writes.length;
    if (stage === 'preflight') reads[0].resolve(rawWorkspace());
    else {
      if (stage === 'mutation') { mutations[0].resolve(); await settle(host); }
      reads[1].resolve(rawWorkspace());
    }
    await settle(host); expect(mutations).toHaveLength(stage === 'preflight' ? 0 : 1);
    expect(publish).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });

  it('suppresses errors after layout cleanup without waiting for passive cleanup', async () => {
    const { host, reads, publish } = await setup(); button(host, 'Appliquer ces réglages').props.onClick(); await settle(host);
    host.unmountLayoutOnly(); const writes = host.writes.length; reads[0].reject(new Error('Synthetic layout-window read refusal')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(publish).not.toHaveBeenCalled();
  });

  it('uses a new actual JSX configuration key for another physical scope with the same company name', async () => {
    const { outer } = await setup();
    const key = () => (one(outer, node => typeof node.type === 'function' && (node.type as Function).name === 'FinanceConfiguration') as Element & { key: string }).key;
    const name = outer.props.workspace.settings.organization.legalName;
    expect(key()).toBe(JSON.stringify([scope, name])); const original = key();
    outer.render({ ...outer.props, workspace: { ...outer.props.workspace } }); expect(key()).toBe(original);
    outer.render({ ...outer.props, workspace: { ...outer.props.workspace, workNotesScope: 'synthetic-finance-scope-b' } });
    expect(key()).toBe(JSON.stringify(['synthetic-finance-scope-b', name])); expect(key()).not.toBe(original);
    const next = key(); outer.render({ ...outer.props, workspace: { ...outer.props.workspace } }); expect(key()).toBe(next);
  });
});
