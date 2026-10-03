import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './types';

// Actual source component and bridge serializers, deterministic hooks and a
// closed diagnostic transport. No native command or external service executes.
const runtime = vi.hoisted(() => ({ host: null as any, invoke: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (...args: any[]) => runtime.host.state(...args),
  useRef: (...args: any[]) => runtime.host.ref(...args),
  useEffect: (...args: any[]) => runtime.host.effect(...args),
}));
vi.mock('./diagnostics', async original => ({ ...await original<typeof import('./diagnostics')>(), diagnosticInvoke: runtime.invoke }));
vi.mock('./language', () => ({ t: (value: string) => value, useAppLanguage: () => {}, getAppLocale: () => 'fr-CH' }));
vi.mock('./PayrollFieldGuide', () => ({ usePayrollFieldGuide: () => ({
  clear() {}, check: () => true, firstInvalid: () => null, reject() {}, guide: null,
}) }));
vi.mock('./PayrollSelect', () => ({ PayrollSelect: () => null }));
vi.mock('./PayrollOrganisationField', () => ({ PayrollOrganisationField: () => null }));
vi.mock('./PayrollContractSetup', () => ({ PayrollContractSetup: () => null }));
vi.mock('./PayrollContributionsPanel', () => ({ PayrollContributionsPanel: () => null }));
vi.mock('./PayrollProblem', () => ({ PayrollProblem: () => null }));
vi.mock('./ui', () => ({ Button: () => null, Field: () => null,
  submitForm: (action: (form: FormData) => Promise<void>) => (event: { syntheticForm: FormData }) => action(event.syntheticForm),
}));
import { desktopApi } from './bridge';
import { PayrollSetup } from './PayrollSetup';
import { PayrollProblem } from './PayrollProblem';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';

type Props = Parameters<typeof PayrollSetup>[0];
type Element = { type: unknown; props: Record<string, any> };
type Target = 'insurance' | 'person' | 'accounts';
class Host {
  slots: any[] = []; index = 0; effects: Array<() => void> = [];
  mounted = true; dirty = false; writes: unknown[] = []; unmountedWrites = 0; tree: unknown;
  constructor(public props: Props) { this.render(); }
  state(initial: any) {
    const slot = this.slots[this.index++] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slot.value, (value: any) => {
      if (!this.mounted) this.unmountedWrites++;
      this.writes.push(value);
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
    this.props = props; this.index = 0; this.effects = []; this.dirty = false;
    runtime.host = this; this.tree = PayrollSetup(props);
    for (const effect of this.effects) effect(); this.flush();
  }
  flush() { if (this.mounted && this.dirty) this.render(); }
  unmount() { for (const slot of this.slots) slot.cleanup?.(); this.mounted = false; }
}
function nodes(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree as Element, ...nodes((tree as Element).props?.children)];
}
function one(host: Host, predicate: (element: Element) => boolean) {
  const matches = nodes(host.tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}
const message = (host: Host) => nodes(host.tree).find(element => element.type === PayrollProblem)?.props.messages[0] ?? '';
async function settle(host?: Host) { for (let n = 0; n < 40; n++) { await Promise.resolve(); host?.flush(); } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const scope = 'synthetic-payroll-scope-a';
const rawAccounts = [
  { id: 'synthetic-expense', code: '5000', name: 'Synthetic salary expense', active: 1, account_type: 'expense' },
  { id: 'synthetic-payable', code: '2200', name: 'Synthetic salary payable', active: 1, account_type: 'liability' },
];
const rawAccounting = { enabled: 1, wages_expense_account_id: rawAccounts[0].id, wages_payable_account_id: rawAccounts[1].id };
function rawWorkspace(origin = scope) {
  return { work_notes_scope: origin, settings: { company_name: 'Synthetic payroll company', extra_settings_json: JSON.stringify({ payroll: {
    enabled: true, fiduciaryValidated: true, payrollCanton: 'VD', accidentInsurer: 'Synthetic original insurer',
    avsFund: 'Synthetic AVS', familyAllowanceFund: 'Synthetic family', pensionFund: '', dailyAllowanceInsurer: '',
  } }) }, employees: [{ id: 'synthetic-employee', name: 'Synthetic employee', birth_date: '1990-01-01',
    employment_start_date: '2026-01-01', employment_contract_kind: 'indefinite', contractual_weekly_minutes: 2400, active: 1 }] };
}
async function setup(target: Target = 'insurance') {
  let initialRead = true, accountReads = 0;
  const reads: ReturnType<typeof deferred<ReturnType<typeof rawWorkspace>>>[] = [];
  const mutations: Array<ReturnType<typeof deferred<any>> & { command: string; args: any }> = [];
  const accountChecks: ReturnType<typeof deferred<typeof rawAccounts>>[] = [];
  const accountingChecks: ReturnType<typeof deferred<typeof rawAccounting>>[] = [];
  runtime.invoke.mockImplementation((command: string, args: any) => {
    if (command === 'get_app_state') return Promise.resolve({ onboarding_completed: 1 });
    if (command === 'get_workspace') {
      if (initialRead) { initialRead = false; return Promise.resolve(rawWorkspace()); }
      const task = deferred<ReturnType<typeof rawWorkspace>>(); reads.push(task); return task.promise;
    }
    if (command === 'list_accounts') {
      if (accountReads++ === 0) return Promise.resolve(rawAccounts);
      const task = deferred<typeof rawAccounts>(); accountChecks.push(task); return task.promise;
    }
    if (command === 'get_accounting_settings') {
      if (accountReads <= 1) return Promise.resolve(rawAccounting);
      const task = deferred<typeof rawAccounting>(); accountingChecks.push(task); return task.promise;
    }
    if (['update_settings', 'update_record', 'configure_accounting'].includes(command)) {
      const task = deferred<any>(); mutations.push({ ...task, command, args }); return task.promise;
    }
    throw Error(`Unexpected native/API command: ${command}`);
  });
  const workspace = await desktopApi.loadWorkspace();
  const saved = vi.fn(), closed = vi.fn(), reasons: unknown[] = [], results: Workspace[] = [];
  const act: Props['act'] = async (action, _message, _close, onError) => {
    try { results.push(await action({workspaceScope:host.props.workspace.workNotesScope!,memberContextNonce:'0123456789abcdef0123456789abcdef'})); return true; }
    catch (reason) { reasons.push(reason); onError?.(reason); return false; }
  };
  const host = new Host({ workspace, initial: target, initialSelector: target === 'insurance' ? '[name=accidentInsurer]' : undefined,
    employeeId: 'synthetic-employee', period: '2026-10', busy: false, guided: target !== 'person', act, onSaved: saved, onClose: closed });
  await settle(host);
  return { host, saved, closed, reasons, results, reads, mutations, accountChecks, accountingChecks };
}
function form(target: Target = 'insurance') {
  const data = new FormData();
  const values = target === 'insurance' ? { accidentInsurer: 'Synthetic retained insurer' }
    : target === 'accounts' ? { wagesExpenseAccountId: rawAccounts[0].id, wagesPayableAccountId: rawAccounts[1].id }
      : { birthDate: '1990-01-01', employmentStartDate: '2026-01-01', weeklyHours: '40', employmentContractKind: 'indefinite' };
  for (const [key, value] of Object.entries(values)) data.set(key, value!); return data;
}
function submit(host: Host, data: FormData = form()) {
  return one(host, element => element.type === 'form').props.onSubmit({ currentTarget: {}, syntheticForm: data, preventDefault() {} }) as Promise<void>;
}
function leave(host: Host, kind: 'unmount' | 'scope' | 'employee' | 'period' | 'destination' | 'section') {
  if (kind === 'unmount') host.unmount();
  else if (kind === 'scope') host.render({ ...host.props, workspace: { ...host.props.workspace, workNotesScope: 'synthetic-payroll-scope-b' } });
  else if (kind === 'employee') host.render({ ...host.props, employeeId: 'synthetic-other-employee' });
  else if (kind === 'period') host.render({ ...host.props, period: '2026-11' });
  else if (kind === 'destination') host.render({ ...host.props, initialSelector: '[name=familyAllowanceFund]' });
  else {
    one(host, element => element.type === 'button' && element.props['aria-current'] !== 'step' && element.props.children === 'Le contrat').props.onClick();
    host.flush();
  }
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function reachMutation(fixture: Fixture, target: Target) {
  fixture.reads[0].resolve(rawWorkspace()); await settle(fixture.host);
  if (target === 'accounts') {
    fixture.accountChecks[0].resolve(rawAccounts); fixture.accountingChecks[0].resolve(rawAccounting); await settle(fixture.host);
  }
  expect(fixture.mutations).toHaveLength(1);
}
const acknowledge = (fixture: Fixture) => fixture.mutations[0].resolve({ settings: rawAccounting });
afterEach(() => { runtime.invoke.mockReset(); runtime.host = null; });

describe('payroll correction lifecycle through the actual component and bridge', () => {
  it.each(['insurance', 'person', 'accounts'] as const)('keeps the normal %s save, payload and callbacks', async target => {
    const fixture = await setup(target), { host, reads, mutations, saved, closed } = fixture;
    const task = submit(host, form(target)); await settle(host); await reachMutation(fixture, target);
    expect(mutations[0].args.expectedWorkspaceScope).toBe(scope);
    expect(mutations[0].command).toBe(target === 'insurance' ? 'update_settings' : target === 'person' ? 'update_record' : 'configure_accounting');
    if (target === 'insurance') {
      const payroll = JSON.parse(mutations[0].args.data.extra_settings_json).payroll;
      expect(payroll.accidentInsurer).toBe('Synthetic retained insurer'); expect(payroll.fiduciaryValidated).toBe(false);
      expect(payroll.avsFund).toBe('Synthetic AVS'); expect(payroll.pensionFund).toBe('');
    }
    if (target === 'person') expect(mutations[0].args).toMatchObject({ entity: 'employees', id: 'synthetic-employee', data: { contractual_weekly_minutes: 2400 } });
    acknowledge(fixture); await settle(host); expect(reads).toHaveLength(2); reads[1].resolve(rawWorkspace());
    await task; await settle(host); expect(saved).toHaveBeenCalledTimes(1); expect(closed).toHaveBeenCalledTimes(1);
    expect(mutations).toHaveLength(1); expect(message(host)).toBe('');
  });

  it.each(['unmount', 'scope', 'employee', 'period', 'destination', 'section'] as const)('does not continue a preflight after %s', async kind => {
    const fixture = await setup(), { host, reads, mutations, saved, closed } = fixture;
    const task = submit(host); await settle(host); leave(host, kind); const writes = host.writes.length;
    reads[0].resolve(rawWorkspace()); await settle(host); expect(mutations).toHaveLength(0); await task;
    expect(saved).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });

  it.each(['insurance', 'person', 'accounts'] as const)('rejects a fresh workspace of another scope before %s dispatch', async target => {
    const fixture = await setup(target), { host, reads, mutations, saved } = fixture;
    const task = submit(host, form(target)); await settle(host); reads[0].resolve(rawWorkspace('synthetic-payroll-scope-b'));
    await settle(host); expect(fixture.accountChecks).toHaveLength(0); expect(mutations).toHaveLength(0); await task; await settle(host); expect(saved).not.toHaveBeenCalled(); expect(message(host)).toMatch(/espace/i);
  });

  it.each(['unmount', 'scope'] as const)('guards the second accounts preflight after %s', async kind => {
    const fixture = await setup('accounts'), { host, reads, mutations, accountChecks, accountingChecks } = fixture;
    const task = submit(host, form('accounts')); await settle(host); reads[0].resolve(rawWorkspace()); await settle(host);
    expect(accountChecks).toHaveLength(1); leave(host, kind); const writes = host.writes.length;
    accountChecks[0].resolve(rawAccounts); accountingChecks[0].resolve(rawAccounting); await settle(host); expect(mutations).toHaveLength(0); await task;
    expect(host.writes).toHaveLength(writes);
  });

  it.each(['unmount', 'scope'] as const)('suppresses late preflight rejection after %s', async kind => {
    const fixture = await setup(), { host, reads, saved, closed } = fixture;
    const task = submit(host); await settle(host); leave(host, kind); const writes = host.writes.length;
    reads[0].reject(new Error('Synthetic late read rejection')); await task; await settle(host);
    expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0); expect(saved).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
  });

  it.each(['insurance', 'person', 'accounts'] as const)('suppresses %s mutation and refresh publication after departure', async target => {
    const fixture = await setup(target), { host, reads, saved, closed } = fixture;
    const task = submit(host, form(target)); await settle(host); await reachMutation(fixture, target);
    host.unmount(); const writes = host.writes.length; acknowledge(fixture); await settle(host);
    if (reads.length === 2) reads[1].resolve(rawWorkspace()); await task; await settle(host);
    expect(saved).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled(); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });

  it.each(['insurance', 'person', 'accounts'] as const)('preserves confirmed %s write on refresh refusal without replay', async target => {
    const fixture = await setup(target), { host, reads, mutations, saved, reasons } = fixture;
    const task = submit(host, form(target)); await settle(host); await reachMutation(fixture, target); acknowledge(fixture); await settle(host);
    reads[1].resolve(rawWorkspace('synthetic-payroll-scope-b')); await task; await settle(host);
    expect(mutations).toHaveLength(1); expect(saved).not.toHaveBeenCalled(); expect(reasons[0]).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(message(host)).toMatch(/enregistrée.*actualisation/); expect(message(host)).toMatch(/espace/i);
  });

  it('keeps the original rejection and entered data, with a new save only after explicit retry', async () => {
    const fixture = await setup(), { host, mutations, reasons, reads, saved } = fixture;
    const data = form(), values = [...data.entries()]; const task = submit(host, data); await settle(host); await reachMutation(fixture, 'insurance');
    const reason = new Error('Synthetic original native refusal'); mutations[0].reject(reason); await task; await settle(host);
    expect(reasons[0]).toBe(reason); expect(message(host)).toBe(reason.message); expect([...data.entries()]).toEqual(values); expect(reads).toHaveLength(1);
    const retry = submit(host, data); await settle(host); expect(reads).toHaveLength(2); reads[1].resolve(rawWorkspace()); await settle(host);
    expect(mutations).toHaveLength(2); mutations[1].resolve({}); await settle(host); reads[2].resolve(rawWorkspace()); await retry;
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('locks two submissions synchronously before the first await', async () => {
    const fixture = await setup(), { host, reads, mutations } = fixture;
    const handler = one(host, element => element.type === 'form').props.onSubmit;
    const event = { currentTarget: {}, syntheticForm: form(), preventDefault() {} };
    const first = handler(event), second = handler(event); await settle(host); expect(reads).toHaveLength(1);
    await reachMutation(fixture, 'insurance'); acknowledge(fixture); await settle(host); reads[1].resolve(rawWorkspace()); await Promise.all([first, second]);
    expect(mutations).toHaveLength(1);
  });

  it('does not close an old form when onSaved unmounts it', async () => {
    const fixture = await setup(), { host, reads, saved, closed } = fixture;
    saved.mockImplementation(() => host.unmount()); const task = submit(host); await settle(host); await reachMutation(fixture, 'insurance');
    acknowledge(fixture); await settle(host); reads[1].resolve(rawWorkspace()); await task; await settle(host);
    expect(saved).toHaveBeenCalledTimes(1); expect(closed).not.toHaveBeenCalled(); expect(host.unmountedWrites).toBe(0);
  });

  it.each(['unmount', 'scope', 'employee', 'destination', 'section', 'busy', 'missingScope', 'emptyScope'] as const)('refuses an old submit handler after %s before validation or reads', async kind => {
    const { host, reads, mutations } = await setup(); const handler = one(host, element => element.type === 'form').props.onSubmit;
    if (kind === 'busy') host.render({ ...host.props, busy: true });
    else if (kind === 'missingScope' || kind === 'emptyScope') host.render({ ...host.props, workspace: { ...host.props.workspace, workNotesScope: kind === 'emptyScope' ? '' : undefined } });
    else leave(host, kind);
    const writes = host.writes.length; const task = handler({ currentTarget: {}, syntheticForm: form(), preventDefault() {} }); await settle(host);
    expect(reads).toHaveLength(0); expect(mutations).toHaveLength(0); expect(host.writes).toHaveLength(writes); await task;
  });

  it.each(['insurance', 'person', 'accounts'] as const)('does not publish %s after scope changes during its refresh', async target => {
    const fixture = await setup(target), { host, reads, saved, closed } = fixture;
    const task = submit(host, form(target)); await settle(host); await reachMutation(fixture, target); acknowledge(fixture); await settle(host);
    expect(reads).toHaveLength(2); leave(host, 'scope'); const writes = host.writes.length;
    reads[1].resolve(rawWorkspace()); await task; await settle(host);
    expect(host.writes).toHaveLength(writes); expect(saved).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
  });

  it.each(['insurance', 'person', 'accounts'] as const)('reports a confirmed %s write if only refresh fails', async target => {
    const fixture = await setup(target), { host, reads, mutations, reasons, saved } = fixture;
    const task = submit(host, form(target)); await settle(host); await reachMutation(fixture, target); acknowledge(fixture); await settle(host);
    const reason = new Error('Synthetic refresh unavailable'); reads[1].reject(reason); await task; await settle(host);
    expect(reasons[0]).toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect((reasons[0] as WorkspaceRefreshAfterMutationError).refreshCause).toBe(reason);
    expect(message(host)).toMatch(/enregistrée.*actualisation.*Synthetic refresh unavailable/);
    expect(mutations).toHaveLength(1); expect(saved).not.toHaveBeenCalled();
  });

  it.each(['unmount', 'scope'] as const)('suppresses a native rejection after %s without a second read', async kind => {
    const fixture = await setup(), { host, reads, mutations, saved, closed } = fixture;
    const task = submit(host); await settle(host); await reachMutation(fixture, 'insurance'); leave(host, kind); const writes = host.writes.length;
    mutations[0].reject(new Error('Synthetic late native refusal')); await task; await settle(host);
    expect(host.writes).toHaveLength(writes); expect(reads).toHaveLength(1); expect(saved).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
  });

  it.each(['unmount', 'scope'] as const)('guards the delayed act result after %s', async kind => {
    const fixture = await setup(), { host, reads, saved, closed } = fixture; const completion = deferred<boolean>();
    host.render({ ...host.props, act: async action => { await action({workspaceScope:host.props.workspace.workNotesScope!,memberContextNonce:'0123456789abcdef0123456789abcdef'}); return completion.promise; } });
    const task = submit(host); await settle(host); await reachMutation(fixture, 'insurance'); acknowledge(fixture); await settle(host);
    reads[1].resolve(rawWorkspace()); await settle(host); leave(host, kind); const writes = host.writes.length;
    completion.resolve(true); await task; await settle(host);
    expect(host.writes).toHaveLength(writes); expect(saved).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
  });

  it('guards catch when the runner itself rejects after unmount', async () => {
    const { host, reads } = await setup(); const completion = deferred<boolean>();
    host.render({ ...host.props, act: () => completion.promise }); const task = submit(host); await settle(host);
    host.unmount(); const writes = host.writes.length; completion.reject(new Error('Synthetic runner rejection')); await task; await settle(host);
    expect(reads).toHaveLength(0); expect(host.writes).toHaveLength(writes); expect(host.unmountedWrites).toBe(0);
  });

  it('checks admission again when the runner delays starting the action', async () => {
    const fixture = await setup(), { host, reads, mutations } = fixture; const start = deferred<void>();
    host.render({ ...host.props, act: async (action, _message, _close, onError) => {
      await start.promise; try { await action({workspaceScope:host.props.workspace.workNotesScope!,memberContextNonce:'0123456789abcdef0123456789abcdef'}); return true; } catch (reason) { onError?.(reason); return false; }
    } });
    const task = submit(host); await settle(host); host.unmount(); const writes = host.writes.length;
    start.resolve(); await settle(host); expect(reads).toHaveLength(0); expect(mutations).toHaveLength(0); expect(host.writes).toHaveLength(writes); await task;
  });

  it('keeps employee snapshot conflict protection', async () => {
    const fixture = await setup('person'), { host, reads, mutations } = fixture; const task = submit(host, form('person')); await settle(host);
    const fresh = rawWorkspace(); fresh.employees[0].name = 'Synthetic concurrent employee'; reads[0].resolve(fresh); await task; await settle(host);
    expect(mutations).toHaveLength(0); expect(message(host)).toMatch(/fiche collaborateur a changé/);
  });

  it('keeps accounting snapshot conflict protection', async () => {
    const fixture = await setup('accounts'), { host, reads, mutations, accountChecks, accountingChecks } = fixture;
    const task = submit(host, form('accounts')); await settle(host); reads[0].resolve(rawWorkspace()); await settle(host);
    accountChecks[0].resolve(rawAccounts); accountingChecks[0].resolve({ ...rawAccounting, wages_payable_account_id: 'synthetic-other-payable' });
    await task; await settle(host); expect(mutations).toHaveLength(0); expect(message(host)).toMatch(/comptes du salaire ont changé/);
  });

  it('keeps payroll snapshot conflict protection', async () => {
    const fixture = await setup(), { host, reads, mutations } = fixture; const task = submit(host); await settle(host);
    const fresh = rawWorkspace(), extra = JSON.parse(fresh.settings.extra_settings_json); extra.payroll.accidentInsurer = 'Synthetic concurrent insurer';
    fresh.settings.extra_settings_json = JSON.stringify(extra); reads[0].resolve(fresh); await task; await settle(host);
    expect(mutations).toHaveLength(0); expect(message(host)).toMatch(/assurances ont changé/);
  });

  it.each(['saveSettings', 'updateEntity', 'configureAccounting'] as const)('keeps legacy %s payload scope omitted and preserves native refusal identity', async method => {
    const fixture = await setup(); const reason = new Error('Synthetic unchanged rejection'); runtime.invoke.mockRejectedValue(reason);
    const action = method === 'saveSettings' ? desktopApi.saveSettings(fixture.host.props.workspace.settings!)
      : method === 'updateEntity' ? desktopApi.updateEntity('employees', 'synthetic-employee', { name: 'Synthetic' })
        : desktopApi.configureAccounting({ enabled: true } as Parameters<typeof desktopApi.configureAccounting>[0]);
    await expect(action).rejects.toBe(reason); expect(runtime.invoke.mock.calls.at(-1)?.[1]).not.toHaveProperty('expectedWorkspaceScope');
  });
});
