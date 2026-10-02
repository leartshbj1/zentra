import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FixedAsset, FixedAssetRow } from './fixedAssets';
import type { Workspace } from './types';

// Exercise the source component and its real API adapter with deferred, local
// responses. This hookhost does not mount React DOM or load native Tauri APIs.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn() }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.useState(...args),
  useRef: (...args: any[]) => runtime.host.useRef(...args),
  useEffect: (...args: any[]) => runtime.host.useEffect(...args),
}));
vi.mock('./diagnostics', () => ({ diagnosticInvoke: runtime.invoke }));
vi.mock('./bridge', () => ({ desktopApi: {
  listAccounts: () => { throw Error('Unexpected account read'); },
  upsertAccount: () => { throw Error('Unexpected account mutation'); },
} }));
vi.mock('./utils', () => ({
  createId: () => '00000000-0000-4000-8000-000000000001',
  todayIso: () => '2026-10-02', formatMoney: (value: number) => String(value),
  errorMessage: (reason: Error, fallback: string) => reason?.message || fallback,
}));
vi.mock('./ui', () => ({
  Button: () => null, Field: () => null, ErrorPanel: () => null, EmptyState: () => null,
  submitForm: (action: () => Promise<void>) => async () => { await action(); },
}));
import { FixedAssetsPanel } from './FixedAssetsPanel';
import { Button, Field, ErrorPanel } from './ui';

type Props = Parameters<typeof FixedAssetsPanel>[0];
type Element = { type: unknown; props: Record<string, any> };
class HookHost {
  slots: any[] = [];
  index = 0;
  dirty = false;
  mounted = true;
  unmountedWrites = 0;
  effects: Array<() => void> = [];
  tree: unknown;
  constructor(public props: Props) { this.render(); }
  useState(initial: any) {
    const slot = this.slots[this.index++] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slot.value, (next: any) => {
      if (!this.mounted) this.unmountedWrites++;
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (!Object.is(value, slot.value)) { slot.value = value; this.dirty = true; }
    }];
  }
  useRef(initial: unknown) { return this.slots[this.index++] ??= { current: initial }; }
  useEffect(effect: () => (() => void) | void, dependencies: unknown[]) {
    const index = this.index++, previous = this.slots[index];
    if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
      this.effects.push(() => {
        previous?.cleanup?.();
        this.slots[index] = { dependencies, cleanup: effect() };
      });
    }
  }
  render(props = this.props) {
    this.props = props; this.index = 0; this.dirty = false; this.effects = [];
    runtime.host = this;
    this.tree = FixedAssetsPanel(props);
    for (const effect of this.effects) effect();
    this.flush();
  }
  flush() { if (this.dirty && this.mounted) this.render(); }
  unmount() { for (const slot of this.slots) slot.cleanup?.(); this.mounted = false; }
}
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object') return [];
  const element = tree as Element;
  return [element, ...elements(element.props?.children)];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (!tree || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text((tree as Element).props?.children) : String(tree);
}
function one(host: HookHost, predicate: (element: Element) => boolean) {
  const matches = elements(host.tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}
function names(host: HookHost) {
  return elements(host.tree).filter(element => element.type === 'article')
    .map(article => text(elements(article).find(element => element.type === 'h3')));
}
const settle = async (host: HookHost) => {
  for (let count = 0; count < 10; count++) { await Promise.resolve(); host.flush(); }
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const workspace = {
  workNotesScope: 'synthetic-scope-a',
  accountingSettings: { enabled: true, bankAccountId: 'bank', expenseAccountId: 'expense' },
  accounts: [
    { id: 'asset', code: '1500', active: true, accountType: 'asset', reportSection: 'fixed_assets' },
    { id: 'depreciation', code: '6800', active: true, accountType: 'expense', reportSection: 'depreciation' },
    { id: 'expense', code: '6000', active: true, accountType: 'expense', reportSection: 'other_operating_expense' },
    { id: 'bank', code: '1020', active: true, accountType: 'asset', reportSection: 'current_assets' },
  ],
} as unknown as Workspace;
const base: FixedAssetRow = {
  asset: { id: '00000000-0000-4000-8000-000000000002', name: 'Synthetic equipment', reference: 'SYNTHETIC-ONLY',
    date: '2026-01-01', costCents: 10000, residualCents: 0, rateBp: 2000, method: 'linear', mode: 'reclassify',
    assetAccountId: 'asset', depreciationAccountId: 'depreciation', counterpartAccountId: 'expense' },
  depreciatedCents: 0, bookValueCents: 10000, cancelled: false,
  nextYear: 2026, nextAmountCents: 2000, blocker: null, history: [],
};
function setup() {
  const reads: ReturnType<typeof deferred<{ items: FixedAssetRow[] }>>[] = [];
  const mutations: Array<ReturnType<typeof deferred<{ items: FixedAssetRow[] }>> & { command: string; args: any }> = [];
  runtime.invoke.mockImplementation((command: string, args: unknown) => {
    const task = deferred<{ items: FixedAssetRow[] }>();
    if (command === 'list_fixed_assets') reads.push(task);
    else if (['register_fixed_asset', 'depreciate_fixed_asset', 'cancel_fixed_asset'].includes(command)) mutations.push({ ...task, command, args });
    else throw Error(`Unexpected native command: ${command}`);
    return task.promise;
  });
  const changed = vi.fn(async () => {});
  const host = new HookHost({ workspace, readOnly: false, onChanged: changed, onSetup: vi.fn() });
  return { host, reads, mutations, changed };
}
function startRegister(host: HookHost) {
  one(host, element => element.type === Button && text(element).includes('Ajouter un bien')).props.onClick(); host.flush();
  one(host, element => element.type === 'input' && element.props.placeholder === 'MacBook de l’entreprise').props.onChange({ target: { value: 'Synthetic new equipment' } }); host.flush();
  one(host, element => element.type === 'input' && element.props.placeholder === 'Numéro de la facture').props.onChange({ target: { value: 'SYNTHETIC-NEW' } }); host.flush();
  const cost = one(host, element => element.type === Field && element.props.label === 'Coût à immobiliser, CHF');
  elements(cost).find(element => element.type === 'input')!.props.onChange({ target: { value: '100' } }); host.flush();
  one(host, element => element.type === 'input' && element.props.type === 'checkbox').props.onChange({ target: { checked: true } }); host.flush();
  void one(host, element => element.type === 'form').props.onSubmit(); host.flush();
}
function startReview(host: HookHost, kind: 'depreciate' | 'cancel') {
  const label = kind === 'cancel' ? 'Annuler le bien' : 'Amortissement 2026';
  one(host, element => element.type === Button && text(element) === label).props.onClick(); host.flush();
  one(host, element => element.type === Button && text(element) === 'Confirmer l’écriture').props.onClick(); host.flush();
}
const registeredRow = (input: FixedAsset): FixedAssetRow => ({ ...base, asset: input });
afterEach(() => { runtime.invoke.mockReset(); runtime.host = null; vi.unstubAllGlobals(); });

describe('fixed asset responses remain ordered in the source component', () => {
  it.each(['register', 'depreciate', 'cancel'] as const)('keeps a successful %s result when an earlier list arrives late', async kind => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const { host, reads, mutations, changed } = setup();
    if (kind !== 'register') {
      reads[0].resolve({ items: [base] }); await settle(host);
      host.render({ ...host.props, workspace: { ...workspace } });
      startReview(host, kind);
    } else startRegister(host);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].command).toBe(`${kind === 'depreciate' ? 'depreciate' : kind}_fixed_asset`);
    if (kind === 'register') expect(mutations[0].args.input).toMatchObject({ costCents: 10000, residualCents: 0, rateBp: 2000, mode: 'reclassify' });
    else expect(mutations[0].args).toEqual(kind === 'cancel' ? { id: base.asset.id, date: '2026-10-02' } : { id: base.asset.id, year: 2026, expected: 2000 });
    const next = kind === 'register' ? registeredRow(mutations[0].args.input)
      : kind === 'cancel' ? { ...base, cancelled: true, bookValueCents: 0 }
        : { ...base, depreciatedCents: 2000, bookValueCents: 8000, history: [{ id: 'synthetic-entry', entry_date: '2026-12-31', amount_cents: 2000 }] };
    mutations[0].resolve({ items: [next] }); await settle(host);
    const visible = text(host.tree);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(kind === 'register' ? 1 : 2);
    reads.at(-1)!.resolve({ items: kind === 'register' ? [] : [base] }); await settle(host);
    expect(text(host.tree)).toBe(visible);
    expect(names(host)).toEqual(kind === 'cancel' ? [] : [next.asset.name]);
    expect(mutations).toHaveLength(1);
  });

  it.each([false, true])('preserves useful reads after a failed mutation, workspace received=%s', async received => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const { host, reads, mutations, changed } = setup(); startRegister(host);
    if (received) host.render({ ...host.props, workspace: { ...workspace } });
    mutations[0].reject(new Error('Synthetic refused mutation')); await settle(host);
    reads.at(-1)!.resolve({ items: [base] }); await settle(host);
    expect(names(host)).toEqual([base.asset.name]);
    expect(reads).toHaveLength(received ? 2 : 1);
    expect(changed).not.toHaveBeenCalled(); expect(mutations).toHaveLength(1);
  });

  it('preserves a received list while refreshing after a confirmed mutation in the same scope', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const { host, reads, mutations, changed } = setup(); startRegister(host);
    host.render({ ...host.props, workspace: { ...workspace } });
    const received = { ...base, asset: { ...base.asset, name: 'Received newer equipment' } };
    reads[1].resolve({ items: [received] }); await settle(host);
    mutations[0].resolve({ items: [registeredRow(mutations[0].args.input)] }); await settle(host);
    expect(names(host)).toEqual(['Received newer equipment']); expect(reads).toHaveLength(3);
    expect(changed).not.toHaveBeenCalled(); expect(mutations).toHaveLength(1);
    reads[2].resolve({ items: [received] }); await settle(host);
    reads[0].resolve({ items: [] }); await settle(host);
    expect(names(host)).toEqual(['Received newer equipment']); expect(changed).toHaveBeenCalledTimes(1);
  });

  it('reports refresh failure as a confirmed write while retaining the received list', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const { host, reads, mutations, changed } = setup(); startRegister(host);
    host.render({ ...host.props, workspace: { ...workspace } });
    reads[1].resolve({ items: [base] }); await settle(host);
    mutations[0].resolve({ items: [registeredRow(mutations[0].args.input)] }); await settle(host);
    expect(reads).toHaveLength(3);
    reads[2].reject(new Error('Synthetic refresh failure')); await settle(host);
    expect(names(host)).toEqual([base.asset.name]);
    const message = one(host, element => element.type === ErrorPanel).props.message;
    expect(message).toContain('L’écriture est enregistrée.');
    expect(message).not.toContain('Votre saisie est conservée');
    expect(changed).toHaveBeenCalledTimes(1); expect(mutations).toHaveLength(1);
  });

  it.each([false, true])('does not publish an old mutation or callback after scope change, unmounted=%s', async unmounted => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const { host, reads, mutations, changed } = setup(); startRegister(host);
    if (unmounted) host.unmount();
    else {
      host.render({ ...host.props, workspace: { ...workspace, workNotesScope: 'synthetic-scope-b' } });
      reads[1].resolve({ items: [base] }); await settle(host);
    }
    const before = text(host.tree);
    mutations[0].resolve({ items: [registeredRow(mutations[0].args.input)] }); await settle(host);
    expect(text(host.tree)).toBe(before); expect(changed).not.toHaveBeenCalled();
    expect(reads).toHaveLength(unmounted ? 1 : 2); expect(host.unmountedWrites).toBe(0);
  });

  it.each([false, true])('does not publish a confirmed refresh or invoke a callback after scope change, unmounted=%s', async unmounted => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const { host, reads, mutations, changed } = setup(); startRegister(host);
    host.render({ ...host.props, workspace: { ...workspace } });
    reads[1].resolve({ items: [base] }); await settle(host);
    mutations[0].resolve({ items: [registeredRow(mutations[0].args.input)] }); await settle(host);
    expect(reads).toHaveLength(3); expect(changed).not.toHaveBeenCalled();
    if (unmounted) host.unmount();
    else {
      host.render({ ...host.props, workspace: { ...workspace, workNotesScope: 'synthetic-scope-b' } });
      reads[3].resolve({ items: [base] }); await settle(host);
    }
    const before = text(host.tree);
    reads[2].resolve({ items: [registeredRow(mutations[0].args.input)] }); await settle(host);
    expect(text(host.tree)).toBe(before); expect(changed).not.toHaveBeenCalled();
    expect(host.unmountedWrites).toBe(0); expect(mutations).toHaveLength(1);
  });

  it.each([false, true])('does not report an old callback rejection after scope change, unmounted=%s', async unmounted => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const { host, reads, mutations, changed } = setup(), callback = deferred<void>();
    changed.mockImplementation(() => callback.promise); startRegister(host);
    mutations[0].resolve({ items: [registeredRow(mutations[0].args.input)] }); await settle(host);
    expect(changed).toHaveBeenCalledTimes(1);
    if (unmounted) host.unmount();
    else {
      host.render({ ...host.props, workspace: { ...workspace, workNotesScope: 'synthetic-scope-b' } });
      reads[1].resolve({ items: [base] }); await settle(host);
    }
    const before = text(host.tree);
    callback.reject(new Error('Synthetic callback failure')); await settle(host);
    expect(text(host.tree)).toBe(before); expect(changed).toHaveBeenCalledTimes(1);
    expect(elements(host.tree).filter(element => element.type === ErrorPanel)).toHaveLength(0);
    expect(host.unmountedWrites).toBe(0);
  });

  it('retains a newer workspace read when the confirmed refresh arrives later', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const { host, reads, mutations, changed } = setup(); startRegister(host);
    host.render({ ...host.props, workspace: { ...workspace } });
    reads[1].resolve({ items: [base] }); await settle(host);
    mutations[0].resolve({ items: [registeredRow(mutations[0].args.input)] }); await settle(host);
    const latestChanged = vi.fn(async () => {});
    host.render({ ...host.props, workspace: { ...workspace }, onChanged: latestChanged });
    const latest = { ...base, asset: { ...base.asset, name: 'Newest received equipment' } };
    reads[3].resolve({ items: [latest] }); await settle(host);
    reads[2].resolve({ items: [base] }); await settle(host);
    expect(names(host)).toEqual(['Newest received equipment']);
    expect(changed).not.toHaveBeenCalled(); expect(latestChanged).toHaveBeenCalledTimes(1);
    expect(mutations).toHaveLength(1);
  });
});
