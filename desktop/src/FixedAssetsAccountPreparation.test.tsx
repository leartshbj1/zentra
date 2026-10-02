import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, Workspace } from './types';

// Run the source component and the actual bridge mapper. Only the diagnostic
// transport is substituted: these fixtures never invoke native APIs or HTTP.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn() }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.useState(...args),
  useRef: (...args: any[]) => runtime.host.useRef(...args),
  useEffect: (...args: any[]) => runtime.host.useEffect(...args),
}));
vi.mock('./diagnostics', () => ({ diagnosticInvoke: runtime.invoke }));
vi.mock('./ui', () => ({
  Button: () => null, Field: () => null, ErrorPanel: () => null, EmptyState: () => null,
  submitForm: (action: () => Promise<void>) => async () => { await action(); },
}));
import { desktopApi } from './bridge';
import { FixedAssetsPanel } from './FixedAssetsPanel';
import { Button, ErrorPanel, Field } from './ui';

type Props = Parameters<typeof FixedAssetsPanel>[0];
type Element = { type: unknown; props: Record<string, any> };
class HookHost {
  slots: any[] = [];
  index = 0;
  dirty = false;
  mounted = true;
  writes: number[] = [];
  unmountedWrites = 0;
  effects: Array<() => void> = [];
  tree: unknown;
  constructor(public props: Props) { this.render(); }
  useState(initial: any) {
    const index = this.index++;
    const slot = this.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slot.value, (next: any) => {
      this.writes.push(index);
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
    runtime.host = this; this.tree = FixedAssetsPanel(props);
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
function one(host: HookHost, predicate: (element: Element) => boolean): Element {
  const matches = elements(host.tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}
function field(host: HookHost, label: string) {
  return one(host, element => element.type === Field && element.props.label === label);
}
function fieldControl(host: HookHost, label: string) {
  return elements(field(host, label)).find(element => element.type === 'input' || element.type === 'select')!;
}
function message(host: HookHost): string {
  return elements(host.tree).find(element => element.type === ErrorPanel)?.props.message || '';
}
async function settle(host?: HookHost) {
  for (let count = 0; count < 20; count++) { await Promise.resolve(); host?.flush(); }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const expense: Account = { id: 'expense', code: '6000', name: 'Synthetic expense', active: true,
  accountType: 'expense', normalBalance: 'debit', reportSection: 'other_operating_expense' };
const rawAccounts = (suffix = '') => [
  { id: 'other-asset', code: '1510', name: `Other equipment${suffix}`, active: 1,
    account_type: 'asset', normal_balance: 'debit', report_section: 'fixed_assets' },
  { id: 'chosen-asset', code: '1500', name: `Chosen equipment${suffix}`, active: '1',
    account_type: 'asset', normal_balance: 'debit', report_section: 'fixed_assets' },
  { id: 'chosen-depreciation', code: '6800', name: `Chosen depreciation${suffix}`, active: true,
    account_type: 'expense', normal_balance: 'debit', report_section: 'depreciation' },
];
const receipt = () => ({ accounts: rawAccounts(), assetAccountId: 'chosen-asset', depreciationAccountId: 'chosen-depreciation' });
const mappedAccounts = (suffix = ''): Account[] => rawAccounts(suffix).map(row => ({ id: row.id, code: row.code,
  name: row.name, active: true, accountType: row.account_type as Account['accountType'],
  normalBalance: 'debit', reportSection: row.report_section as Account['reportSection'] }));
const workspace = { workNotesScope: 'synthetic-scope-a', accounts: [expense],
  accountingSettings: { enabled: true, expenseAccountId: expense.id, bankAccountId: 'bank' } } as unknown as Workspace;
function setup(overrides: Partial<Props> = {}) {
  const preparations: Array<ReturnType<typeof deferred<ReturnType<typeof receipt>>> & { args: unknown }> = [];
  const reads: ReturnType<typeof deferred<ReturnType<typeof rawAccounts>>>[] = [];
  runtime.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === 'list_fixed_assets') return Promise.resolve({ items: [] });
    if (command === 'prepare_fixed_asset_accounts') {
      const task = deferred<ReturnType<typeof receipt>>(); preparations.push({ ...task, args }); return task.promise;
    }
    if (command === 'list_accounts') {
      const task = deferred<ReturnType<typeof rawAccounts>>(); reads.push(task); return task.promise;
    }
    // A local acknowledgement lets the original implementation reach its
    // incorrect continuations in the RED run; no native write is performed.
    if (command === 'upsert_account') return Promise.resolve();
    throw Error(`Unexpected native command: ${command}`);
  });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
  const changed = vi.fn(async () => {});
  const host = new HookHost({ workspace, readOnly: false, onChanged: changed, onSetup: vi.fn(), ...overrides });
  return { host, changed, preparations, reads };
}
function edit(host: HookHost) {
  one(host, element => element.type === Button && text(element).includes('Ajouter un bien')).props.onClick(); host.flush();
  one(host, element => element.type === 'input' && element.props.placeholder === 'MacBook de l’entreprise')
    .props.onChange({ target: { value: 'Synthetic retained equipment' } }); host.flush();
  one(host, element => element.type === 'input' && element.props.placeholder === 'Numéro de la facture')
    .props.onChange({ target: { value: 'SYNTHETIC-RETAINED' } }); host.flush();
  for (const [label, value] of [['Coût à immobiliser, CHF', '1200,50'], ['Taux annuel, %', '25'], ['Valeur résiduelle, CHF', '12']]) {
    fieldControl(host, label).props.onChange({ target: { value } }); host.flush();
  }
  one(host, element => element.type === 'input' && element.props.type === 'checkbox').props.onChange({ target: { checked: true } }); host.flush();
}
function retainedInput(host: HookHost) {
  return { name: fieldControl(host, 'Nom du bien').props.value, reference: fieldControl(host, 'Référence d’achat').props.value,
    date: fieldControl(host, 'Date d’acquisition').props.value, mode: fieldControl(host, 'Cet achat est-il déjà dans votre comptabilité ?').props.value,
    cost: fieldControl(host, 'Coût à immobiliser, CHF').props.value, rate: fieldControl(host, 'Taux annuel, %').props.value,
    residual: fieldControl(host, 'Valeur résiduelle, CHF').props.value, counterpart: fieldControl(host, 'Charge déjà comptabilisée').props.value,
    confirmed: one(host, element => element.type === 'input' && element.props.type === 'checkbox').props.checked };
}
function preparationHandler(host: HookHost): () => void {
  return one(host, element => element.type === Button && text(element) === 'Ajouter les comptes nécessaires').props.onClick;
}
function accountLabels(host: HookHost) {
  return elements(field(host, 'Compte d’immobilisation')).filter(element => element.type === 'option').map(text);
}
function leave(host: HookHost, kind: 'unmount' | 'scope') {
  if (kind === 'unmount') host.unmount();
  else host.render({ ...host.props, workspace: { ...host.props.workspace, workNotesScope: 'synthetic-scope-b' } });
}
afterEach(() => { runtime.invoke.mockReset(); runtime.host = null; vi.unstubAllGlobals(); });

describe('fixed asset account preparation through the source component and bridge', () => {
  it('sends the mandatory origin scope and maps the actual native account DTO', async () => {
    const raw = receipt(); runtime.invoke.mockResolvedValue(raw);
    const result = await desktopApi.prepareFixedAssetAccounts('synthetic-scope-a');
    expect(runtime.invoke).toHaveBeenCalledExactlyOnceWith('prepare_fixed_asset_accounts', { expectedWorkspaceScope: 'synthetic-scope-a' });
    expect(result).toEqual({ accounts: mappedAccounts(), assetAccountId: raw.assetAccountId, depreciationAccountId: raw.depreciationAccountId });
  });

  it('preserves the rejection object from the transport', async () => {
    const reason = new Error('Synthetic original scope refusal'); runtime.invoke.mockRejectedValue(reason);
    await expect(desktopApi.prepareFixedAssetAccounts('synthetic-scope-a')).rejects.toBe(reason);
  });

  it('uses one atomic receipt and its chosen IDs without rereading or changing the entered form', async () => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host);
    const input = retainedInput(host); preparationHandler(host)(); host.flush(); await settle(host);
    expect(preparations).toHaveLength(1); expect(preparations[0].args).toEqual({ expectedWorkspaceScope: 'synthetic-scope-a' });
    expect(changed).not.toHaveBeenCalled();
    preparations[0].resolve(receipt()); await settle(host);
    expect(reads).toHaveLength(0); expect(runtime.invoke.mock.calls.map(call => call[0])).not.toContain('upsert_account');
    expect(fieldControl(host, 'Compte d’immobilisation').props.value).toBe('chosen-asset');
    expect(fieldControl(host, 'Charge d’amortissement').props.value).toBe('chosen-depreciation');
    expect(accountLabels(host)).toContain('1500 · Chosen equipment'); expect(retainedInput(host)).toEqual(input);
    expect(changed).toHaveBeenCalledTimes(1); expect(one(host, element => element.type === 'fieldset').props.disabled).toBe(false);
  });

  it('locks a repeated click synchronously until the atomic response', async () => {
    const { host, preparations } = setup(); await settle(host); edit(host);
    const handler = preparationHandler(host); handler(); handler(); host.flush(); await settle(host);
    expect(preparations).toHaveLength(1); expect(one(host, element => element.type === 'fieldset').props.disabled).toBe(true);
    preparations[0].resolve(receipt()); await settle(host); expect(preparations).toHaveLength(1);
  });

  it.each(['readOnly', 'missingScope', 'emptyScope', 'unmount', 'scope'] as const)('refuses dispatch when %s invalidates the action', async kind => {
    const { host, preparations, reads } = setup(); await settle(host); edit(host); const handler = preparationHandler(host);
    if (kind === 'readOnly') {
      host.render({ ...host.props, readOnly: true }); preparationHandler(host)();
    } else if (kind === 'missingScope' || kind === 'emptyScope') {
      host.render({ ...host.props, workspace: { ...workspace, workNotesScope: kind === 'emptyScope' ? '' : undefined } });
      preparationHandler(host)();
    } else { leave(host, kind); handler(); }
    await settle(host); expect(preparations).toHaveLength(0); expect(reads).toHaveLength(0); expect(host.unmountedWrites).toBe(0);
  });

  it('retains the original refusal and inputs, with a new write only on an explicit retry', async () => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host); const input = retainedInput(host);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1);
    preparations[0].reject(new Error('Synthetic 6800 incompatible: no accounts committed')); await settle(host);
    expect(message(host)).toBe('Synthetic 6800 incompatible: no accounts committed'); expect(retainedInput(host)).toEqual(input);
    expect(changed).not.toHaveBeenCalled(); expect(reads).toHaveLength(0); expect(preparations).toHaveLength(1);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(2);
    preparations[1].resolve(receipt()); await settle(host); expect(changed).toHaveBeenCalledTimes(1); expect(message(host)).toBe('');
  });

  it.each(['unmount', 'scope'] as const)('does not publish a late success after %s', async kind => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1); leave(host, kind); await settle(host);
    const writes = host.writes.length, before = text(host.tree);
    preparations[0].resolve(receipt()); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(text(host.tree)).toBe(before); expect(changed).not.toHaveBeenCalled();
    expect(host.unmountedWrites).toBe(0); expect(reads).toHaveLength(0); expect(preparations).toHaveLength(1);
  });

  it.each(['unmount', 'scope'] as const)('does not publish a late refusal after %s', async kind => {
    const { host, changed, preparations } = setup(); await settle(host); edit(host);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1); leave(host, kind); await settle(host);
    const writes = host.writes.length;
    preparations[0].reject(new Error('Synthetic old-space refusal')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(changed).not.toHaveBeenCalled(); expect(host.unmountedWrites).toBe(0);
  });

  it('retains a received workspace while making just one protected read after confirmation', async () => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host); const input = retainedInput(host);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1);
    const latestChanged = vi.fn(async () => {});
    host.render({ ...host.props, workspace: { ...workspace, accounts: mappedAccounts(' received') }, onChanged: latestChanged }); await settle(host);
    preparations[0].resolve(receipt()); await settle(host); expect(reads).toHaveLength(1);
    expect(accountLabels(host)).toContain('1500 · Chosen equipment received'); expect(latestChanged).not.toHaveBeenCalled();
    reads[0].resolve(rawAccounts(' refreshed')); await settle(host);
    expect(accountLabels(host)).toContain('1500 · Chosen equipment refreshed'); expect(retainedInput(host)).toEqual(input);
    expect(fieldControl(host, 'Compte d’immobilisation').props.value).toBe('chosen-asset');
    expect(changed).not.toHaveBeenCalled(); expect(latestChanged).toHaveBeenCalledTimes(1); expect(preparations).toHaveLength(1);
  });

  it('reports a failed exceptional read as accounts recorded and keeps received accounts and input', async () => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host); const input = retainedInput(host);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1);
    host.render({ ...host.props, workspace: { ...workspace, accounts: mappedAccounts(' received') } }); await settle(host);
    preparations[0].resolve(receipt()); await settle(host); expect(reads).toHaveLength(1);
    reads[0].reject(new Error('Synthetic account refresh failure')); await settle(host);
    expect(message(host)).toContain('Les comptes sont enregistrés.'); expect(message(host)).not.toContain('préparés');
    expect(accountLabels(host)).toContain('1500 · Chosen equipment received'); expect(retainedInput(host)).toEqual(input);
    expect(changed).toHaveBeenCalledTimes(1); expect(preparations).toHaveLength(1); expect(reads).toHaveLength(1);
  });

  it.each(['success', 'failure'] as const)('keeps a third workspace received during the exceptional read, response=%s', async outcome => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1);
    host.render({ ...host.props, workspace: { ...workspace, accounts: mappedAccounts(' second') } }); await settle(host);
    preparations[0].resolve(receipt()); await settle(host); expect(reads).toHaveLength(1);
    const latestChanged = vi.fn(async () => {});
    host.render({ ...host.props, workspace: { ...workspace, accounts: mappedAccounts(' third') }, onChanged: latestChanged }); await settle(host);
    if (outcome === 'success') reads[0].resolve(rawAccounts(' obsolete'));
    else reads[0].reject(new Error('Synthetic obsolete read failure'));
    await settle(host);
    expect(accountLabels(host)).toContain('1500 · Chosen equipment third');
    expect(accountLabels(host).join('')).not.toContain('obsolete'); expect(reads).toHaveLength(1); expect(preparations).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled(); expect(latestChanged).toHaveBeenCalledTimes(1);
    expect(fieldControl(host, 'Compte d’immobilisation').props.value).toBe('chosen-asset');
    if (outcome === 'failure') expect(message(host)).toContain('Les comptes sont enregistrés.');
  });

  it.each(['unmount', 'scope'] as const)('does not publish an exceptional read after %s', async kind => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1);
    host.render({ ...host.props, workspace: { ...workspace, accounts: mappedAccounts(' received') } }); await settle(host);
    preparations[0].resolve(receipt()); await settle(host); expect(reads).toHaveLength(1);
    leave(host, kind); await settle(host); const writes = host.writes.length;
    reads[0].resolve(rawAccounts(' old')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(changed).not.toHaveBeenCalled(); expect(host.unmountedWrites).toBe(0);
    expect(preparations).toHaveLength(1);
  });

  it.each(['unmount', 'scope'] as const)('does not publish an exceptional read failure after %s', async kind => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1);
    host.render({ ...host.props, workspace: { ...workspace, accounts: mappedAccounts(' received') } }); await settle(host);
    preparations[0].resolve(receipt()); await settle(host); expect(reads).toHaveLength(1);
    leave(host, kind); await settle(host); const writes = host.writes.length;
    reads[0].reject(new Error('Synthetic old read failure')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(changed).not.toHaveBeenCalled(); expect(host.unmountedWrites).toBe(0);
  });

  it('distinguishes a current callback failure from a refused preparation', async () => {
    const { host, changed, preparations, reads } = setup(); await settle(host); edit(host); const input = retainedInput(host);
    changed.mockRejectedValue(new Error('Synthetic callback refresh failure'));
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1);
    preparations[0].resolve(receipt()); await settle(host);
    expect(message(host)).toContain('Les comptes sont enregistrés.'); expect(retainedInput(host)).toEqual(input);
    expect(changed).toHaveBeenCalledTimes(1); expect(reads).toHaveLength(0); expect(preparations).toHaveLength(1);
  });

  it.each(['unmount', 'scope'] as const)('does not publish a callback rejection after %s', async kind => {
    const { host, changed, preparations } = setup(); await settle(host); edit(host);
    const callback = deferred<void>(); changed.mockImplementation(() => callback.promise);
    preparationHandler(host)(); await settle(host); expect(preparations).toHaveLength(1);
    preparations[0].resolve(receipt()); await settle(host); expect(changed).toHaveBeenCalledTimes(1);
    leave(host, kind); await settle(host); const writes = host.writes.length;
    callback.reject(new Error('Synthetic late callback failure')); await settle(host);
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(changed).toHaveBeenCalledTimes(1);
    expect(preparations).toHaveLength(1);
  });
});
