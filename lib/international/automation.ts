import { validateCompanyConfiguration } from './country-config';
import {
  subscriptionRights,
  type SaasSubscriptionAuthority,
  type SubscriptionEnvironment,
} from './subscriptions';
import type { CompanyConfiguration, Money } from './types';

export type WorkflowKind = 'vendor_invoice' | 'customer_request' | 'meeting';
export type AutomationFailureCode =
  | 'invalid_source'
  | 'invalid_time_zone'
  | 'ambiguous_time'
  | 'nonexistent_time'
  | 'permission_denied'
  | 'consent_required'
  | 'configuration_changed'
  | 'idempotency_conflict'
  | 'provider_unavailable'
  | 'classification_requires_review'
  | 'approval_required'
  | 'invalid_store_record';

export class AutomationContractError extends Error {
  constructor(public readonly code: AutomationFailureCode) {
    super(code);
    this.name = 'AutomationContractError';
  }
}

interface SourceIdentity {
  readonly organizationId: string;
  readonly sourceId: string;
  readonly language: 'en' | 'fr';
  /** Original user content; normalization never translates it. */
  readonly text: string;
}
export type AutomationSource = SourceIdentity &
  (
    | {
        readonly kind: 'vendor_invoice';
        readonly supplierId: string;
        readonly invoiceReference: string;
        readonly amounts: {
          readonly net: Money;
          readonly tax: Money;
          readonly total: Money;
        };
      }
    | {
        readonly kind: 'customer_request';
        readonly customerId: string;
        readonly subject: string;
      }
    | {
        readonly kind: 'meeting';
        readonly title: string;
        readonly localStart: string;
        readonly localEnd: string;
        readonly timeZone: string;
        readonly startsAt: number;
        readonly endsAt: number;
      }
  );

const key = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const kinds: readonly WorkflowKind[] = [
  'vendor_invoice',
  'customer_request',
  'meeting',
];
const fail = (code: AutomationFailureCode): never => {
  throw new AutomationContractError(code);
};
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return fail('invalid_source');
  return input as Record<string, unknown>;
}
function text(input: unknown, maximum: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum)
    return fail('invalid_source');
  return input;
}
function identifier(input: unknown): string {
  return key(input) ? input : fail('invalid_source');
}
function field(
  input: Record<string, unknown>,
  en: string,
  fr?: string,
): unknown {
  if (fr && en in input && fr in input) return fail('invalid_source');
  return en in input ? input[en] : fr ? input[fr] : undefined;
}
function money(input: unknown): Money {
  const value = object(input);
  if (
    Object.keys(value).some(
      (name) => !['currency', 'minorUnits'].includes(name),
    ) ||
    !['CHF', 'USD'].includes(String(value.currency)) ||
    typeof value.minorUnits !== 'string' ||
    !/^(0|[1-9][0-9]{0,29})$/.test(value.minorUnits)
  )
    return fail('invalid_source');
  return Object.freeze({
    currency: value.currency as Money['currency'],
    minorUnits: value.minorUnits,
  });
}

/** Explicit IANA zone; DST folds/gaps require human correction, never a guessed offset. */
export function resolveLocalMeetingTime(
  local: string,
  timeZone: string,
): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match || Number(match[1]) < 2000 || Number(match[1]) > 2100)
    return fail('invalid_source');
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(naive);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  )
    return fail('invalid_source');
  if (
    typeof timeZone !== 'string' ||
    timeZone.length > 128 ||
    !timeZone.includes('/')
  )
    return fail('invalid_time_zone');
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return fail('invalid_time_zone');
  }
  const parts = (instant: number) =>
    Object.fromEntries(
      format
        .formatToParts(instant)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sampled = naive + hours * 3_600_000;
    const value = parts(sampled);
    offsets.add(
      Date.UTC(
        value.year,
        value.month - 1,
        value.day,
        value.hour,
        value.minute,
        value.second,
      ) - sampled,
    );
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((instant) => {
      const value = parts(instant);
      return (
        value.year === year &&
        value.month === month &&
        value.day === day &&
        value.hour === hour &&
        value.minute === minute
      );
    });
  if (candidates.length === 0) return fail('nonexistent_time');
  if (candidates.length !== 1) return fail('ambiguous_time');
  return candidates[0] / 1000;
}

/** Structured, already reviewed facts only. A text body cannot invent invoice amounts or dates. */
export function normalizeAutomationSource(
  input: unknown,
  company: CompanyConfiguration,
): AutomationSource {
  const context = validateCompanyConfiguration(company);
  const value = object(input);
  const aliases: Record<string, WorkflowKind> = {
    vendor_invoice: 'vendor_invoice',
    facture_fournisseur: 'vendor_invoice',
    customer_request: 'customer_request',
    demande_client: 'customer_request',
    meeting: 'meeting',
    rendez_vous: 'meeting',
  };
  const kind = Object.hasOwn(aliases, String(value.kind))
    ? aliases[String(value.kind)]
    : undefined;
  if (!kind) return fail('invalid_source');
  const common = [
    'kind',
    'organizationId',
    'sourceId',
    'language',
    'langue',
    'text',
    'texte',
  ];
  const extra =
    kind === 'vendor_invoice'
      ? ['supplierId', 'invoiceReference', 'amounts']
      : kind === 'customer_request'
        ? ['customerId', 'subject', 'objet']
        : [
            'title',
            'titre',
            'localStart',
            'debutLocal',
            'localEnd',
            'finLocale',
            'timeZone',
            'fuseauHoraire',
          ];
  if (
    Object.keys(value).some((name) => ![...common, ...extra].includes(name)) ||
    value.organizationId !== context.organizationId
  )
    return fail('invalid_source');
  const language = field(value, 'language', 'langue');
  if (language !== 'en' && language !== 'fr') return fail('invalid_source');
  const identity = {
    organizationId: context.organizationId,
    sourceId: identifier(value.sourceId),
    language,
    text: text(field(value, 'text', 'texte'), 100_000),
  } as const;
  if (kind === 'vendor_invoice') {
    const amounts = object(value.amounts);
    if (
      Object.keys(amounts).some(
        (name) => !['net', 'tax', 'total'].includes(name),
      )
    )
      return fail('invalid_source');
    const net = money(amounts.net),
      tax = money(amounts.tax),
      total = money(amounts.total);
    if (
      net.currency !== context.currency ||
      tax.currency !== net.currency ||
      total.currency !== net.currency ||
      BigInt(net.minorUnits) + BigInt(tax.minorUnits) !==
        BigInt(total.minorUnits)
    )
      return fail('invalid_source');
    return Object.freeze({
      ...identity,
      kind,
      supplierId: identifier(value.supplierId),
      invoiceReference: text(value.invoiceReference, 256),
      amounts: Object.freeze({ net, tax, total }),
    });
  }
  if (kind === 'customer_request')
    return Object.freeze({
      ...identity,
      kind,
      customerId: identifier(value.customerId),
      subject: text(field(value, 'subject', 'objet'), 256),
    });
  const localStart = text(field(value, 'localStart', 'debutLocal'), 16),
    localEnd = text(field(value, 'localEnd', 'finLocale'), 16);
  const timeZone = text(field(value, 'timeZone', 'fuseauHoraire'), 128);
  if (timeZone !== context.timeZone) return fail('invalid_time_zone');
  const startsAt = resolveLocalMeetingTime(localStart, timeZone),
    endsAt = resolveLocalMeetingTime(localEnd, timeZone);
  if (endsAt <= startsAt) return fail('invalid_source');
  return Object.freeze({
    ...identity,
    kind,
    title: text(field(value, 'title', 'titre'), 256),
    localStart,
    localEnd,
    timeZone,
    startsAt,
    endsAt,
  });
}

export interface ExecutionAuthority {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipActive: boolean;
  readonly role: 'owner' | 'admin' | 'accountant' | 'member' | 'read_only';
  readonly company: CompanyConfiguration;
  readonly environment: SubscriptionEnvironment;
  readonly subscriptions: readonly SaasSubscriptionAuthority[];
  readonly consent: { readonly approved: boolean; readonly version: string };
  readonly enabledWorkflows: readonly WorkflowKind[];
}
export interface ClassificationProvider {
  /** Output is untrusted; provider performs classification, not financial extraction or execution. */
  classify(source: AutomationSource): Promise<unknown>;
}
export interface AutomationProposal {
  readonly kind: 'automation_proposal';
  readonly organizationId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly source: AutomationSource;
  readonly action:
    | 'record_vendor_invoice_draft'
    | 'create_customer_request'
    | 'draft_meeting';
  readonly financial: boolean;
  readonly requiresHumanApproval: true;
}
export interface AutomationRunRecord {
  readonly organizationId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly fingerprint: string;
  readonly authorityFingerprint: string;
  readonly source: AutomationSource;
  readonly revision: number;
  readonly attempts: number;
  readonly state:
    | 'classifying'
    | 'proposed'
    | 'dispatching'
    | 'completed'
    | 'failed'
    | 'uncertain'
    | 'review_required';
  readonly proposal: AutomationProposal | null;
  readonly failure: {
    readonly code: AutomationFailureCode;
    readonly retryable: boolean;
  } | null;
  readonly resultReference: string | null;
}
/** Durable adapter must atomically preserve immutable scope/fingerprints and monotone revisions. */
export interface AutomationRunStore {
  createIfAbsent(record: AutomationRunRecord): Promise<{
    readonly created: boolean;
    readonly record: AutomationRunRecord;
  }>;
  read(
    organizationId: string,
    requestId: string,
  ): Promise<AutomationRunRecord | null>;
  compareAndSwap(
    organizationId: string,
    requestId: string,
    revision: number,
    next: AutomationRunRecord,
  ): Promise<AutomationRunRecord | null>;
}
export interface HumanApproval {
  readonly approvalId: string;
  readonly organizationId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly approverId: string;
  readonly approved: boolean;
  readonly expiresAt: number;
}
export interface AutomationDependencies {
  readonly store: AutomationRunStore;
  readonly classifier: ClassificationProvider;
  /** All authority/approval loaders are authenticated server-side, never browser objects. */
  readAuthority(scope: {
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<ExecutionAuthority | null>;
  readApproval(approvalId: string): Promise<HumanApproval | null>;
  readonly clock: () => number;
  readonly sink: {
    /** Implementations must fence fresh tenant/role/entitlements in the same transaction as their mutation. */
    commit(input: {
      readonly proposal: AutomationProposal;
      readonly idempotencyKey: string;
      readonly actorId: string;
      readonly approvalId: string;
      readonly authorityFingerprint: string;
    }): Promise<{ readonly referenceId: string }>;
  };
}
export type AutomationWorkflowResult = {
  readonly state:
    | 'processing'
    | 'proposed'
    | 'completed'
    | 'failed'
    | 'uncertain'
    | 'review_required';
  readonly requestId: string;
  readonly proposal: AutomationProposal | null;
  readonly resultReference: string | null;
  readonly failure: AutomationRunRecord['failure'];
};

function canonical(input: unknown): string {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  const value = input as Record<string, unknown>;
  return `{${Object.keys(value)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`)
    .join(',')}}`;
}
async function digest(input: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(input)),
  );
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
async function authority(
  scope: { organizationId: string; userId: string },
  kind: WorkflowKind,
  deps: AutomationDependencies,
) {
  const current = await deps.readAuthority(scope);
  if (
    !current ||
    current.organizationId !== scope.organizationId ||
    current.userId !== scope.userId ||
    current.membershipActive !== true ||
    current.company.organizationId !== scope.organizationId ||
    !['owner', 'admin', 'accountant', 'member'].includes(current.role) ||
    (kind === 'vendor_invoice' && current.role === 'member')
  )
    return fail('permission_denied');
  const company = validateCompanyConfiguration(current.company);
  const now = deps.clock();
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !['TEST', 'PRODUCTION'].includes(current.environment)
  )
    return fail('permission_denied');
  if (
    current.consent.approved !== true ||
    !key(current.consent.version) ||
    !current.enabledWorkflows.includes(kind)
  )
    return fail('consent_required');
  // Multiple write-granting authorities for one module are contradictory, not an arbitrary choice.
  for (const requiredModule of ['gestion', 'automation'] as const) {
    const grants = current.subscriptions.filter(
      (subscription) =>
        subscriptionRights(company, subscription, {
          module: requiredModule,
          environment: current.environment,
          now,
        }).access === 'read_write',
    );
    if (grants.length !== 1) return fail('permission_denied');
  }
  return {
    company,
    fingerprint: await digest({
      organizationId: scope.organizationId,
      userId: scope.userId,
      company,
      environment: current.environment,
      role: current.role,
      consent: current.consent,
      enabledWorkflows: [...current.enabledWorkflows].sort(),
      subscriptions: [...current.subscriptions].sort((a, b) =>
        a.subscriptionId.localeCompare(b.subscriptionId),
      ),
    }),
  };
}
function assertRecord(
  record: AutomationRunRecord,
  scope: { organizationId: string; userId: string; requestId: string },
): void {
  if (
    record.organizationId !== scope.organizationId ||
    record.requestId !== scope.requestId ||
    record.actorId !== scope.userId ||
    record.source.organizationId !== scope.organizationId ||
    !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
    !/^[a-f0-9]{64}$/.test(record.authorityFingerprint) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !Number.isSafeInteger(record.attempts) ||
    record.attempts < 1 ||
    record.attempts > 3 ||
    ![
      'classifying',
      'proposed',
      'dispatching',
      'completed',
      'failed',
      'uncertain',
      'review_required',
    ].includes(record.state)
  )
    return fail('invalid_store_record');
}
const result = (record: AutomationRunRecord): AutomationWorkflowResult =>
  Object.freeze({
    state:
      record.state === 'classifying' || record.state === 'dispatching'
        ? 'processing'
        : record.state,
    requestId: record.requestId,
    proposal: record.proposal,
    resultReference: record.resultReference,
    failure: record.failure,
  });

/** Idempotent proposal preparation only. Retry is explicit and only before any sink effect. */
export async function prepareAutomationWorkflow(
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly source: unknown;
    readonly retryPreparation?: boolean;
  },
  deps: AutomationDependencies,
): Promise<AutomationWorkflowResult> {
  if (![input.organizationId, input.userId, input.requestId].every(key))
    return fail('invalid_source');
  const raw = object(input.source),
    rawKind = String(raw.kind);
  const kind: WorkflowKind =
    rawKind === 'facture_fournisseur'
      ? 'vendor_invoice'
      : rawKind === 'demande_client'
        ? 'customer_request'
        : rawKind === 'rendez_vous'
          ? 'meeting'
          : (rawKind as WorkflowKind);
  if (!kinds.includes(kind)) return fail('invalid_source');
  const context = await authority(input, kind, deps);
  const source = normalizeAutomationSource(input.source, context.company);
  const fingerprint = await digest({
    source,
    actorId: input.userId,
    authorityFingerprint: context.fingerprint,
  });
  const initial: AutomationRunRecord = Object.freeze({
    organizationId: input.organizationId,
    requestId: input.requestId,
    actorId: input.userId,
    fingerprint,
    authorityFingerprint: context.fingerprint,
    source,
    revision: 0,
    attempts: 1,
    state: 'classifying',
    proposal: null,
    failure: null,
    resultReference: null,
  });
  const admission = await deps.store.createIfAbsent(initial);
  let record = admission.record;
  assertRecord(record, input);
  if (record.fingerprint !== fingerprint) return fail('idempotency_conflict');
  if (!admission.created) {
    if (
      input.retryPreparation !== true ||
      record.state !== 'failed' ||
      record.failure?.retryable !== true ||
      record.attempts >= 3
    )
      return result(record);
    const retry = await deps.store.compareAndSwap(
      input.organizationId,
      input.requestId,
      record.revision,
      {
        ...record,
        revision: record.revision + 1,
        attempts: record.attempts + 1,
        state: 'classifying',
        failure: null,
      },
    );
    if (!retry)
      return result(
        (await deps.store.read(input.organizationId, input.requestId)) ??
          record,
      );
    record = retry;
  }
  let classification: unknown;
  try {
    classification = await deps.classifier.classify(source);
  } catch {
    const failed = await deps.store.compareAndSwap(
      input.organizationId,
      input.requestId,
      record.revision,
      {
        ...record,
        revision: record.revision + 1,
        state: 'failed',
        failure: { code: 'provider_unavailable', retryable: true },
      },
    );
    return result(failed ?? record);
  }
  try {
    const fresh = await authority(input, kind, deps);
    if (fresh.fingerprint !== context.fingerprint)
      return fail('configuration_changed');
  } catch (error) {
    await deps.store.compareAndSwap(
      input.organizationId,
      input.requestId,
      record.revision,
      {
        ...record,
        revision: record.revision + 1,
        state: 'failed',
        failure: {
          code:
            error instanceof AutomationContractError
              ? error.code
              : 'permission_denied',
          retryable: false,
        },
      },
    );
    throw error;
  }
  const classified =
    classification &&
    typeof classification === 'object' &&
    !Array.isArray(classification)
      ? (classification as Record<string, unknown>)
      : {};
  const valid =
    Object.keys(classified).every((name) =>
      ['kind', 'confidence'].includes(name),
    ) &&
    classified.kind === kind &&
    typeof classified.confidence === 'number' &&
    Number.isFinite(classified.confidence) &&
    classified.confidence >= 0.9 &&
    classified.confidence <= 1;
  const proposal: AutomationProposal | null = valid
    ? Object.freeze({
        kind: 'automation_proposal',
        organizationId: input.organizationId,
        requestId: input.requestId,
        fingerprint,
        source,
        action:
          kind === 'vendor_invoice'
            ? 'record_vendor_invoice_draft'
            : kind === 'customer_request'
              ? 'create_customer_request'
              : 'draft_meeting',
        financial: kind === 'vendor_invoice',
        requiresHumanApproval: true,
      })
    : null;
  const saved = await deps.store.compareAndSwap(
    input.organizationId,
    input.requestId,
    record.revision,
    {
      ...record,
      revision: record.revision + 1,
      state: valid ? 'proposed' : 'review_required',
      proposal,
      failure: valid
        ? null
        : { code: 'classification_requires_review', retryable: false },
    },
  );
  return result(
    saved ??
      (await deps.store.read(input.organizationId, input.requestId)) ??
      record,
  );
}

/** Explicit approval + fresh authority + one CAS dispatch. An unknown financial result is never retried here. */
export async function commitAutomationWorkflow(
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly approvalId: string;
  },
  deps: AutomationDependencies,
): Promise<AutomationWorkflowResult> {
  if (
    ![
      input.organizationId,
      input.userId,
      input.requestId,
      input.approvalId,
    ].every(key)
  )
    return fail('approval_required');
  let record = await deps.store.read(input.organizationId, input.requestId);
  if (!record) return fail('invalid_store_record');
  assertRecord(record, input);
  const current = await authority(input, record.source.kind, deps);
  if (current.fingerprint !== record.authorityFingerprint)
    return fail('configuration_changed');
  if (
    (await digest({
      source: record.source,
      actorId: input.userId,
      authorityFingerprint: record.authorityFingerprint,
    })) !== record.fingerprint
  )
    return fail('invalid_store_record');
  if (record.state !== 'proposed') return result(record);
  if (
    !record.proposal ||
    record.proposal.kind !== 'automation_proposal' ||
    record.proposal.organizationId !== input.organizationId ||
    record.proposal.requestId !== input.requestId ||
    record.proposal.fingerprint !== record.fingerprint ||
    record.proposal.requiresHumanApproval !== true ||
    canonical(record.proposal.source) !== canonical(record.source) ||
    record.proposal.financial !== (record.source.kind === 'vendor_invoice') ||
    record.proposal.action !==
      (record.source.kind === 'vendor_invoice'
        ? 'record_vendor_invoice_draft'
        : record.source.kind === 'customer_request'
          ? 'create_customer_request'
          : 'draft_meeting')
  )
    return fail('invalid_store_record');
  const approval = await deps.readApproval(input.approvalId);
  if (
    !approval ||
    approval.approvalId !== input.approvalId ||
    approval.organizationId !== input.organizationId ||
    approval.requestId !== input.requestId ||
    approval.fingerprint !== record.fingerprint ||
    approval.approverId !== input.userId ||
    approval.approved !== true ||
    !Number.isSafeInteger(approval.expiresAt) ||
    approval.expiresAt <= deps.clock()
  )
    return fail('approval_required');
  const claimed = await deps.store.compareAndSwap(
    input.organizationId,
    input.requestId,
    record.revision,
    {
      ...record,
      revision: record.revision + 1,
      state: 'dispatching',
      failure: null,
    },
  );
  if (!claimed)
    return result(
      (await deps.store.read(input.organizationId, input.requestId)) ?? record,
    );
  record = claimed;
  // Authority changing while approval/CAS awaited must prevent the effect. Sink additionally fences the transaction.
  try {
    const fresh = await authority(input, record.source.kind, deps);
    if (fresh.fingerprint !== record.authorityFingerprint)
      return fail('configuration_changed');
    const freshApproval = await deps.readApproval(input.approvalId);
    if (
      !freshApproval ||
      freshApproval.approvalId !== input.approvalId ||
      freshApproval.organizationId !== input.organizationId ||
      freshApproval.requestId !== input.requestId ||
      freshApproval.fingerprint !== record.fingerprint ||
      freshApproval.approverId !== input.userId ||
      freshApproval.approved !== true ||
      !Number.isSafeInteger(freshApproval.expiresAt) ||
      freshApproval.expiresAt <= deps.clock()
    )
      return fail('approval_required');
  } catch (error) {
    await deps.store.compareAndSwap(
      input.organizationId,
      input.requestId,
      record.revision,
      {
        ...record,
        revision: record.revision + 1,
        state: 'failed',
        failure: {
          code:
            error instanceof AutomationContractError
              ? error.code
              : 'permission_denied',
          retryable: false,
        },
      },
    );
    throw error;
  }
  try {
    const committed = await deps.sink.commit({
      proposal: record.proposal!,
      idempotencyKey: `${input.organizationId}:${input.requestId}:${record.fingerprint}`,
      actorId: input.userId,
      approvalId: input.approvalId,
      authorityFingerprint: record.authorityFingerprint,
    });
    if (!key(committed.referenceId)) return fail('invalid_store_record');
    const saved = await deps.store.compareAndSwap(
      input.organizationId,
      input.requestId,
      record.revision,
      {
        ...record,
        revision: record.revision + 1,
        state: 'completed',
        resultReference: committed.referenceId,
      },
    );
    return result(
      saved ??
        (await deps.store.read(input.organizationId, input.requestId)) ??
        record,
    );
  } catch {
    const saved = await deps.store.compareAndSwap(
      input.organizationId,
      input.requestId,
      record.revision,
      {
        ...record,
        revision: record.revision + 1,
        state: 'uncertain',
        failure: { code: 'provider_unavailable', retryable: false },
      },
    );
    return result(saved ?? record);
  }
}
