import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { validateErpRequest } from './erp-request';
import type { ErpExecutionDependencies } from './runtime';
import type { ErpRequest } from './runtime-types';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { Estimate } from './invoicing';
import { executeUsTaxInvoiceTest } from './us-tax-invoice';
import type { UsTaxFinancialContext, UsTaxFinancialContextReader } from './us-tax-financial-context';
import type { ResolvedUsTaxTestMerchant } from './us-tax-merchant-resolver';
import { validateUsTaxMerchantCredential, type UsTaxMerchantStore } from './us-tax-merchant-store';
import type { UsTaxOperationStore } from './us-tax-operation-store';
import { validateUsTaxInvoicePreparation, type UsTaxInvoicePreparation, type UsTaxInvoicePreparationStore } from './us-tax-invoice-preparation-store';

export interface UsTaxInvoicePrivateDependencies {
  enabled(): boolean | Promise<boolean>;
  merchant(organizationId: string): Promise<ResolvedUsTaxTestMerchant | null>;
  merchantStore(): UsTaxMerchantStore | Promise<UsTaxMerchantStore>;
  contexts(revalidate: () => Promise<FinancialAuthority>): UsTaxFinancialContextReader | Promise<UsTaxFinancialContextReader>;
  now(): string;
}
export interface UsTaxInvoiceTestRuntimeDependencies extends UsTaxInvoicePrivateDependencies {
  preparations(capability: ErpSchemaVersion): UsTaxInvoicePreparationStore | Promise<UsTaxInvoicePreparationStore>;
  operations(capability: ErpSchemaVersion): UsTaxOperationStore | Promise<UsTaxOperationStore>;
  operationId(): string;
}
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
export function usTaxInvoiceContextFacts(context: UsTaxFinancialContext) {
  const { actor: _actor, recordedAt: _recordedAt, ...facts } = context;
  return facts;
}
/** One operation retains its original gateway while re-resolving only the
 * private credential identity around awaits. No SDK or provider grant is shared. */
export function createUsTaxInvoicePrivateScope(dependencies: UsTaxInvoicePrivateDependencies, original: FinancialAuthority, revalidate: () => Promise<FinancialAuthority>) {
  original = snapshotPrivateJson(original) as FinancialAuthority;
  let previousClock = -Infinity, previousAuthority = -Infinity, started: number | undefined;
  let selected: ResolvedUsTaxTestMerchant | undefined, contexts: UsTaxFinancialContextReader | undefined, store: UsTaxMerchantStore | undefined;
  function clock(): number {
    let now: number;
    try { now = parseInstant(dependencies.now()).getTime(); } catch { throw new ErpError('server_clock_unavailable', 503); }
    if (!Number.isFinite(now) || now < previousClock) throw new ErpError('server_clock_unavailable', 503);
    previousClock = now; return now;
  }
  async function authority(): Promise<FinancialAuthority> {
    const actor = snapshotPrivateJson(await revalidate()) as FinancialAuthority;
    if (!actor || actor.organizationId !== original.organizationId || actor.userId !== original.userId) throw new ErpError('session_changed', 401);
    if (actor.managementEntitled !== true) throw new ErpError('management_entitlement_required', 402);
    if (!['owner', 'admin', 'accountant'].includes(actor.role) || actor.role !== original.role) throw new ErpError('financial_permission_required', 403);
    let timestamp: number;
    try { timestamp = parseInstant(actor.timestamp).getTime(); } catch { throw new ErpError('server_clock_unavailable', 503); }
    if (timestamp < previousAuthority || timestamp > clock()) throw new ErpError('server_clock_unavailable', 503);
    previousAuthority = timestamp; return actor;
  }
  async function admitted(): Promise<FinancialAuthority> {
    await authority();
    let failure: unknown, failed = false;
    try {
      if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
      const current = await dependencies.merchant(original.organizationId);
      if (!current) throw new ErpError('binding_unavailable', 409);
      validateUsTaxMerchantCredential({ credential: current.credential, configurationFingerprint: current.configurationFingerprint });
      if (selected && (!same(current.credential, selected.credential) || current.configurationFingerprint !== selected.configurationFingerprint)) throw new ErpError('tax_binding_changed', 409);
      if (!selected) { selected = current; started = clock(); }
    } catch (error) { failed = true; failure = error; }
    // Actual access loss takes priority over private/configuration failure.
    const actor = await authority();
    if (!await dependencies.enabled()) throw new ErpError('feature_unavailable', 404);
    if (started !== undefined && clock() - started >= 30_000) throw new ErpError('binding_unavailable', 409);
    if (failed) throw failure;
    return actor;
  }
  async function checked<T>(work: (actor: FinancialAuthority) => T | Promise<T>): Promise<T> {
    const actor = await admitted();
    let result: T | undefined, failure: unknown, failed = false;
    try { result = await work(actor); } catch (error) { failed = true; failure = error; }
    await admitted();
    if (failed) throw failure;
    return result as T;
  }
  async function readContext(): Promise<UsTaxFinancialContext> {
    if (!contexts) contexts = await checked(() => dependencies.contexts(admitted));
    if (!store) store = await checked(() => dependencies.merchantStore());
    const context = snapshotPrivateJson(await checked(actor => contexts!.read(actor))) as UsTaxFinancialContext;
    const provenance = await checked(actor => store!.readCredential(actor, context.binding.revision));
    if (!selected || !provenance || !same(provenance.credential, selected.credential) || provenance.configurationFingerprint !== selected.configurationFingerprint || context.organizationId !== original.organizationId || context.binding.accountId !== selected.credential.accountId || context.binding.evidenceKind !== 'provider_observation') throw new ErpError('binding_unavailable', 409);
    return context;
  }
  async function contextStillCurrent(context: UsTaxFinancialContext): Promise<void> {
    if (!same(usTaxInvoiceContextFacts(await readContext()), usTaxInvoiceContextFacts(context))) throw new ErpError('tax_configuration_changed', 409);
  }
  return {
    authority, admitted, checked, readContext, contextStillCurrent,
    merchant(): ResolvedUsTaxTestMerchant { if (!selected) throw new ErpError('binding_unavailable', 409); return selected; },
    async verify(context: UsTaxFinancialContext) {
      await contextStillCurrent(context);
      await checked(() => selected!.gateway.verify(context));
      await contextStillCurrent(context);
    },
  };
}

/** The hook is always installed but all current TEST work is admitted lazily.
 * ERP and committed operation receipts remain historical after merchant expiry. */
export function createUsTaxInvoiceTestRuntime(dependencies: UsTaxInvoiceTestRuntimeDependencies) {
  return async (execution: Pick<ErpExecutionDependencies, 'store' | 'configuration' | 'actor' | 'revalidate'>, request: ErpRequest) => {
    request = validateErpRequest(snapshotPrivateJson(request), execution.actor.organizationId);
    const originalStore = execution.store;
    execution = {
      configuration: snapshotPrivateJson(execution.configuration) as typeof execution.configuration,
      actor: snapshotPrivateJson(execution.actor) as FinancialAuthority,
      revalidate: execution.revalidate.bind(execution),
      store: { supportedSchemaVersion: originalStore.supportedSchemaVersion ?? 1, read: originalStore.read.bind(originalStore), receipt: originalStore.receipt.bind(originalStore), commit: originalStore.commit.bind(originalStore) },
    };
    const scope = createUsTaxInvoicePrivateScope(dependencies, execution.actor, execution.revalidate);
    const capability = execution.store.supportedSchemaVersion ?? 1;
    let operations: UsTaxOperationStore | undefined, preparations: UsTaxInvoicePreparationStore | undefined;
    async function operationStore() { if (!operations) operations = await dependencies.operations(capability); return operations; }
    async function preparation(context: UsTaxFinancialContext, estimate?: Estimate): Promise<UsTaxInvoicePreparation> {
      if (!preparations) preparations = await scope.checked(() => dependencies.preparations(capability));
      const actor = await scope.admitted();
      const saved = await scope.checked(admitted => preparations!.read(admitted, request));
      if (!saved) throw new ErpError('tax_preparation_required', 409);
      const confirmed = await scope.checked(() => validateUsTaxInvoicePreparation(saved, actor, request));
      const merchant = scope.merchant();
      if (!same(confirmed.context, usTaxInvoiceContextFacts(context)) || !same(confirmed.merchant.credential, merchant.credential) || confirmed.merchant.configurationFingerprint !== merchant.configurationFingerprint || estimate && !same(confirmed.estimate, estimate)) throw new ErpError('tax_configuration_changed', 409);
      return confirmed;
    }
    return executeUsTaxInvoiceTest({
      erp: execution,
      contexts: { read: () => scope.readContext() },
      operations: {
        // No TEST gate or preparation is read while looking for history.
        read: async (actor, key, hash) => (await operationStore()).read(actor, key, hash),
        reserve: (actor, resolved) => scope.checked(async () => (await operationStore()).reserve(actor, resolved)),
        record: (actor, resolved, calculated) => scope.checked(async () => (await operationStore()).record(actor, resolved, calculated)),
        commit: (id, input) => scope.checked(async () => (await operationStore()).commit(id, input)),
      },
      gateway: {
        verify: context => scope.verify(context),
        calculate: resolved => scope.checked(() => scope.merchant().gateway.calculate(resolved)),
      },
      classifications: async (context, estimate) => (await preparation(context, estimate)).classifications,
      transactionLocation: async context => { const saved = await preparation(context); return { taxDateInstant: saved.taxDateInstant, addressSource: saved.addressSource }; },
      operationId: dependencies.operationId, now: dependencies.now,
    }, request);
  };
}
