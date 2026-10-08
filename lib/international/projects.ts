import { validDate, type FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { money } from './money';
import { snapshotPrivateJson } from './private-json';
import type { CompanyConfiguration, Currency, Money } from './types';

export interface ProjectInput {
  readonly id: string;
  readonly expectedProjectRevision: number;
  readonly customerId: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  readonly notes: string;
  readonly startDate: string | null;
  readonly targetDate: string | null;
  /** Planned net amount; no tax determination or automatic profit claim. */
  readonly budgetMinor: string | null;
  readonly vendorBillIds: readonly string[];
}
export interface StoredProject {
  readonly id: string;
  readonly organizationId: string;
  readonly currency: Currency;
  readonly revision: number;
  readonly number: string;
  readonly customerId: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  readonly notes: string;
  readonly startDate: string | null;
  readonly targetDate: string | null;
  readonly budget: Money | null;
  readonly vendorBillIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
const inputFields = ['id','expectedProjectRevision','customerId','name','status','notes','startDate','targetDate','budgetMinor','vendorBillIds'];
const storedFields = ['id','organizationId','currency','revision','number','customerId','name','status','notes','startDate','targetDate','budget','vendorBillIds','createdAt','updatedAt'];
function fail(code = 'invalid_request', status = 422): never { throw new ErpError(code, status); }
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  if (Reflect.ownKeys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) return fail();
  return input as Record<string, unknown>;
}
function detached(input: unknown): unknown { try { return snapshotPrivateJson(input); } catch { return fail(); } }
function freeze<T>(input: T): T { return snapshotPrivateJson(input) as T; }
function text(input: unknown, maximum = 160): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || Array.from(input).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail();
  return input;
}
function notes(input: unknown): string {
  if (typeof input !== 'string' || input.length > 20_000 || Array.from(input).some(c => c.charCodeAt(0) === 127 || (c.charCodeAt(0) < 32 && ![9,10,13].includes(c.charCodeAt(0))))) return fail();
  return input;
}
function civil(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string' || input.startsWith('0000-') || !validDate(input)) return fail('invalid_date');
  return input;
}
function minor(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string' || !/^(?:0|[1-9][0-9]{0,35})$/.test(input)) return fail('invalid_amount');
  return input;
}
function revision(input: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(input) || (input as number) < (allowZero ? 0 : 1) || (input as number) >= Number.MAX_SAFE_INTEGER) return fail();
  return input as number;
}
function number(input: unknown): string {
  if (typeof input !== 'string' || !/^PRJ-[0-9]{6,16}$/.test(input) || BigInt(input.slice(4)) < BigInt(1) || BigInt(input.slice(4)) >= BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return input;
}
function instant(input: unknown): string {
  if (typeof input !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(input)) return fail();
  try { parseInstant(input); } catch { return fail(); }
  return input;
}
function bills(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > 1000) return fail();
  const result = input.map(value => text(value));
  if (new Set(result).size !== result.length) return fail();
  return result;
}
function fields(value: Record<string, unknown>) {
  if (value.status !== 'active' && value.status !== 'archived') return fail();
  const startDate = civil(value.startDate), targetDate = civil(value.targetDate);
  if (startDate !== null && targetDate !== null && targetDate < startDate) return fail('invalid_date');
  return { id: text(value.id), customerId: text(value.customerId), name: text(value.name, 200), status: value.status, notes: notes(value.notes), startDate, targetDate, vendorBillIds: bills(value.vendorBillIds) } as const;
}
export function validateProjectInput(input: unknown): ProjectInput {
  const value = object(detached(input), inputFields);
  return freeze({ ...fields(value), expectedProjectRevision: revision(value.expectedProjectRevision, true), budgetMinor: minor(value.budgetMinor) });
}
/** Structural validation never substitutes for workspace admission or entity existence. */
export function validateStoredProject(input: unknown, configuration: CompanyConfiguration): StoredProject {
  try {
    const company = validateCompanyConfiguration(detached(configuration)), value = object(detached(input), storedFields);
    if (value.organizationId !== company.organizationId || value.currency !== company.currency) return fail();
    const budgetValue = value.budget === null ? null : object(value.budget, ['currency','minorUnits']);
    if (budgetValue && budgetValue.currency !== company.currency) return fail();
    const budgetMinor = budgetValue ? minor(budgetValue.minorUnits) : null;
    if (budgetValue && budgetMinor === null) return fail();
    const createdAt = instant(value.createdAt), updatedAt = instant(value.updatedAt);
    if (parseInstant(updatedAt) < parseInstant(createdAt)) return fail();
    return freeze({ ...fields(value), organizationId: company.organizationId, currency: company.currency, revision: revision(value.revision), number: number(value.number), budget: budgetMinor === null ? null : money(company.currency, budgetMinor), createdAt, updatedAt });
  } catch { return fail('invalid_stored_state', 503); }
}
/** The runtime owns customer/link validation, numbering, global CAS and audit. */
export function recordProject(configuration: CompanyConfiguration, input: ProjectInput, previous: StoredProject | null, assignedNumber: string, actor: FinancialAuthority): StoredProject {
  const company = validateCompanyConfiguration(detached(configuration)), value = validateProjectInput(input);
  const admitted = object(detached(actor), ['organizationId','userId','role','managementEntitled','timestamp']);
  if (admitted.organizationId !== company.organizationId) return fail('tenant_mismatch', 403);
  if (admitted.managementEntitled !== true) return fail('management_entitlement_required', 402);
  if (!['owner','admin','accountant'].includes(String(admitted.role))) return fail('financial_permission_required', 403);
  text(admitted.userId);
  const timestamp = instant(admitted.timestamp), earlier = previous === null ? null : validateStoredProject(previous, company), assigned = number(assignedNumber);
  if (value.expectedProjectRevision !== (earlier?.revision ?? 0)) return fail('revision_conflict', 409);
  if (earlier && (earlier.id !== value.id || earlier.number !== assigned || parseInstant(timestamp) < parseInstant(earlier.updatedAt))) return fail('revision_conflict', 409);
  const nextRevision = (earlier?.revision ?? 0) + 1;
  if (nextRevision >= Number.MAX_SAFE_INTEGER) return fail('revision_conflict', 409);
  return validateStoredProject({ id: value.id, organizationId: company.organizationId, currency: company.currency, revision: nextRevision, number: assigned, customerId: value.customerId, name: value.name, status: value.status, notes: value.notes, startDate: value.startDate, targetDate: value.targetDate, budget: value.budgetMinor === null ? null : money(company.currency, value.budgetMinor), vendorBillIds: value.vendorBillIds, createdAt: earlier?.createdAt ?? timestamp, updatedAt: timestamp }, company);
}
