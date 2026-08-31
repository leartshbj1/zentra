import { Channel, invoke } from '@tauri-apps/api/core';
import type { OpenDialogOptions, SaveDialogOptions } from '@tauri-apps/plugin-dialog';
import type {
  Account,
  AccountingFallback,
  AccountingPeriod,
  AccountingSettings,
  AppSettings,
  BalanceSheetReport,
  CalculatedPayrollContribution,
  Client,
  DocumentLine,
  Employee,
  EmployeePayrollTemplate,
  EntityKind,
  Expense,
  FrozenCustomer,
  FrozenDocumentSnapshot,
  FrozenEmployee,
  FrozenIssuer,
  FrozenPayslipSnapshot,
  Invoice,
  IncomeStatementReport,
  JournalEntry,
  JournalLine,
  JournalReport,
  LedgerReport,
  LicenseState,
  NogaCatalog,
  OnboardingPayload,
  Payment,
  Payslip,
  PayslipContributionSnapshot,
  PayslipLine,
  PayrollDocumentImport,
  PayrollImportDraft,
  PayrollCalculation,
  PayrollContributionDefinition,
  PayrollContributionSelection,
  PayrollRegulatoryProfile,
  PeriodFilter,
  PostPayslipResult,
  Project,
  Quote,
  Reminder,
  ReminderHistory,
  ReminderSettings,
  ReminderStatus,
  ReminderTemplate,
  ReportCurrency,
  SecureUpdateEvent,
  SecureUpdateMetadata,
  SecureUpdaterPolicy,
  StatementRow,
  StatementScope,
  StoredSwissQrBill,
  SwissQrBillInput,
  SwissQrPayload,
  SwissQrValidation,
  TimeEntry,
  TrialBalanceReport,
  TrialBalanceRow,
  Workspace,
} from './types';

type RawRecord = Record<string, unknown>;
type AppState = { onboarding_completed: boolean; activity_profile_required?: boolean; data_dir: string; database_path: string; app_version: string };
export type OnboardingValidationIssue = { step: number; field: string; label: string; message: string };
export type OnboardingValidationResult = { valid: boolean; issues: OnboardingValidationIssue[] };
type RawWorkspace = {
  settings?: RawRecord | null;
  clients?: RawRecord[];
  projects?: RawRecord[];
  quotes?: RawRecord[];
  quote_items?: RawRecord[];
  invoices?: RawRecord[];
  invoice_items?: RawRecord[];
  invoice_qr_bills?: RawRecord[];
  employees?: RawRecord[];
  time_entries?: RawRecord[];
  expenses?: RawRecord[];
  payslips?: RawRecord[];
  payslip_items?: RawRecord[];
  payroll_document_imports?: RawRecord[];
  employee_payroll_templates?: RawRecord[];
  payments?: RawRecord[];
  active_timer?: RawRecord | null;
};

const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberValue = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const boolValue = (value: unknown): boolean => value === true || value === 1 || value === '1';
const recordValue = (value: unknown): RawRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : {};

/**
 * Les sauvegardes conservent les logos hashés mais une restauration sur un autre
 * compte Windows change APPLOCALDATA. Le snapshot métier reste immuable : seul
 * son pointeur de lecture est rebasé vers le dossier local courant.
 */
export function rebaseStoredBrandingPath(value: unknown, dataDir: string): string {
  const stored = stringValue(value).trim();
  if (!stored || !dataDir) return stored;
  const fileName = stored.split(/[\\/]/).at(-1) ?? '';
  if (!/^logo-[0-9a-f]{64}\.(?:png|jpe?g|webp)$/i.test(fileName)) return stored;
  const separator = dataDir.includes('\\') ? '\\' : '/';
  return `${dataDir.replace(/[\\/]+$/, '')}${separator}attachments${separator}branding${separator}${fileName}`;
}

function appStateFromRaw(value: unknown): AppState {
  const row = recordValue(value);
  return {
    onboarding_completed: boolValue(row.onboarding_completed ?? row.onboardingCompleted),
    activity_profile_required: boolValue(row.activity_profile_required ?? row.activityProfileRequired),
    data_dir: stringValue(row.data_dir ?? row.dataDir),
    database_path: stringValue(row.database_path ?? row.databasePath),
    app_version: stringValue(row.app_version ?? row.appVersion),
  };
}

function secureUpdaterPolicyFromRaw(value: unknown): SecureUpdaterPolicy {
  const row = recordValue(value);
  return {
    enabled: boolValue(row.enabled),
    currentVersion: stringValue(row.currentVersion ?? row.current_version),
    channel: 'stable',
    endpointHost: stringValue(row.endpointHost ?? row.endpoint_host) || null,
    signatureRequired: true,
    transport: 'HTTPS',
    automaticInstall: false,
    reason: stringValue(row.reason),
  };
}

function secureUpdateMetadataFromRaw(value: unknown): SecureUpdateMetadata {
  const row = recordValue(value);
  return {
    version: stringValue(row.version),
    currentVersion: stringValue(row.currentVersion ?? row.current_version),
    date: stringValue(row.date) || null,
    notes: stringValue(row.notes) || null,
  };
}

function secureUpdateEventFromRaw(value: unknown): SecureUpdateEvent | null {
  const row = recordValue(value);
  const event = stringValue(row.event);
  const data = recordValue(row.data);
  if (event === 'preparing' || event === 'verifying' || event === 'installed') return { event };
  if (event === 'started') {
    return { event, data: { contentLength: data.contentLength === null || data.content_length === null ? null : numberValue(data.contentLength ?? data.content_length) || null } };
  }
  if (event === 'progress') {
    return {
      event,
      data: {
        downloadedBytes: numberValue(data.downloadedBytes ?? data.downloaded_bytes),
        contentLength: data.contentLength === null || data.content_length === null ? null : numberValue(data.contentLength ?? data.content_length) || null,
        percent: data.percent === null || data.percent === undefined ? null : Math.max(0, Math.min(100, numberValue(data.percent))),
      },
    };
  }
  return null;
}

function onboardingValidationFromRaw(value: unknown): OnboardingValidationResult {
  const row = recordValue(value);
  const issues = (Array.isArray(row.issues) ? row.issues : []).map((value): OnboardingValidationIssue => {
    const issue = recordValue(value);
    return {
      step: Math.max(0, Math.trunc(numberValue(issue.step))),
      field: stringValue(issue.field).trim(),
      label: stringValue(issue.label).trim(),
      message: stringValue(issue.message).trim(),
    };
  });
  return { valid: boolValue(row.valid) && issues.length === 0, issues };
}

function parsedSnapshot(value: unknown): RawRecord | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RawRecord : null; }
  catch { return null; }
}

function payslipLineKindFromRaw(value: unknown): PayslipLine['kind'] {
  const kind = stringValue(value);
  if (kind === 'non_gross_payment' || kind === 'expense_reimbursement') return 'reimbursement';
  return (['earning', 'deduction', 'reimbursement', 'employer'].includes(kind) ? kind : 'earning') as PayslipLine['kind'];
}

function payrollImportDraftFromRaw(value: unknown): PayrollImportDraft {
  const root = typeof value === 'string' ? parsedSnapshot(value) ?? {} : recordValue(value);
  const employee = recordValue(root.employee);
  const lines = Array.isArray(root.lines) ? root.lines.map(recordValue) : [];
  return {
    employee: {
      employeeNumber: stringValue(employee.employee_number ?? employee.employeeNumber),
      name: stringValue(employee.name),
      role: stringValue(employee.role),
      addressLine1: stringValue(employee.address_line1 ?? employee.addressLine1),
      addressLine2: stringValue(employee.address_line2 ?? employee.addressLine2),
      postalCode: stringValue(employee.postal_code ?? employee.postalCode),
      city: stringValue(employee.city),
      canton: stringValue(employee.canton),
      birthDate: stringValue(employee.birth_date ?? employee.birthDate),
      avsNumber: stringValue(employee.avs_number ?? employee.avsNumber),
      iban: stringValue(employee.iban),
      employmentRate: numberValue(employee.employment_rate ?? employee.employmentRate) || 100,
      salaryMode: stringValue(employee.salary_mode ?? employee.salaryMode) === 'hourly' ? 'hourly' : 'monthly',
    },
    period: stringValue(root.period),
    paymentDate: stringValue(root.payment_date ?? root.paymentDate),
    grossCents: numberValue(root.gross_cents ?? root.grossCents),
    netCents: numberValue(root.net_cents ?? root.netCents),
    lines: lines.map((line, index) => ({
      id: stringValue(line.id) || `import-line-${index}`,
      label: stringValue(line.label),
      kind: payslipLineKindFromRaw(line.kind),
      amountCents: numberValue(line.amount_cents ?? line.amountCents),
      recurring: boolValue(line.recurring),
      confidenceBp: numberValue(line.confidence_bp ?? line.confidenceBp),
    })),
    warnings: Array.isArray(root.warnings) ? root.warnings.map(stringValue).filter(Boolean) : [],
  };
}

function payrollImportFromRaw(row: RawRecord): PayrollDocumentImport {
  return {
    id: stringValue(row.id),
    sourceName: stringValue(row.source_name),
    storedPath: stringValue(row.stored_path),
    fileSha256: stringValue(row.file_sha256),
    mediaKind: stringValue(row.media_kind) === 'image' ? 'image' : 'pdf',
    fileSize: numberValue(row.file_size),
    extractionEngine: stringValue(row.extraction_engine),
    engineVersion: stringValue(row.engine_version),
    extractedText: stringValue(row.extracted_text),
    draft: payrollImportDraftFromRaw(row.draft_json),
    confidenceBp: numberValue(row.confidence_bp),
    status: (['needs_review', 'confirmed', 'rejected', 'error'].includes(stringValue(row.status)) ? stringValue(row.status) : 'needs_review') as PayrollDocumentImport['status'],
    errorMessage: stringValue(row.error_message),
    employeeId: stringValue(row.employee_id),
    payslipId: stringValue(row.payslip_id),
    reviewedAt: stringValue(row.reviewed_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function employeePayrollTemplateFromRaw(row: RawRecord): EmployeePayrollTemplate {
  const recurring = (() => {
    try { return typeof row.recurring_earnings_json === 'string' ? JSON.parse(row.recurring_earnings_json) as unknown : []; }
    catch { return []; }
  })();
  const codes = (() => {
    try { return typeof row.suggested_contribution_codes_json === 'string' ? JSON.parse(row.suggested_contribution_codes_json) as unknown : []; }
    catch { return []; }
  })();
  return {
    employeeId: stringValue(row.employee_id),
    salaryMode: stringValue(row.salary_mode) === 'hourly' ? 'hourly' : 'monthly',
    baseSalaryCents: numberValue(row.base_salary_cents),
    recurringEarnings: Array.isArray(recurring) ? recurring.map(recordValue).map((line) => ({ label: stringValue(line.label), kind: 'earning' as const, amountCents: numberValue(line.amount_cents ?? line.amountCents) })).filter((line) => line.label && line.amountCents > 0) : [],
    suggestedContributionCodes: Array.isArray(codes) ? codes.map(stringValue).filter(Boolean) : [],
    sourceImportId: stringValue(row.source_import_id),
    reviewedAt: stringValue(row.reviewed_at),
  };
}

function licenseStateFromRaw(row: RawRecord): LicenseState {
  return {
    enforcementConfigured: boolValue(row.enforcement_configured),
    status: stringValue(row.status) as LicenseState['status'],
    readOnly: boolValue(row.read_only),
    plan: stringValue(row.plan),
    priceChfCents: numberValue(row.price_chf_cents),
    licenseId: stringValue(row.license_id),
    customerName: stringValue(row.customer_name),
    validFrom: stringValue(row.valid_from),
    validUntil: stringValue(row.valid_until),
    verifiedAt: stringValue(row.verified_at),
    lastSeenDate: stringValue(row.last_seen_date),
    reason: stringValue(row.reason),
    installationId: stringValue(row.installation_id),
    tokenVersion: numberValue(row.token_version),
  };
}

function parseExtra(settings: RawRecord): Partial<AppSettings> {
  const raw = settings.extra_settings_json;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<AppSettings>) : {};
  } catch {
    return {};
  }
}

function settingsFromRaw(row: RawRecord | null | undefined, dataDir = ''): AppSettings | null {
  if (!row || !stringValue(row.company_name)) return null;
  const extra = parseExtra(row);
  const extraBilling = extra.billing;
  const configuredVat = extraBilling?.vatRatesBp?.filter((rate) => Number.isFinite(rate)) ?? [];
  const defaultVat = numberValue(row.default_vat_bp);
  return {
    organization: {
      legalName: stringValue(row.company_name),
      legalForm: stringValue(row.legal_form),
      contactName: stringValue(row.owner_name),
      email: stringValue(row.email),
      phone: stringValue(row.phone),
      website: extra.organization?.website ?? '',
      uidNumber: stringValue(row.uid_number),
      vatNumber: stringValue(row.vat_number),
      vatRegistered: boolValue(row.vat_registered),
      address: {
        street: [stringValue(row.address_line1), stringValue(row.address_line2)].filter(Boolean).join('\n'),
        buildingNumber: extra.organization?.address?.buildingNumber ?? '',
        postalCode: stringValue(row.postal_code),
        city: stringValue(row.city),
        canton: stringValue(row.canton),
        country: stringValue(row.country),
      },
      logoPath: rebaseStoredBrandingPath(row.logo_path, dataDir) || undefined,
    },
    business: {
      nogaSection: (/^[A-V]$/.test(stringValue(row.noga_section)) ? stringValue(row.noga_section) : '') as AppSettings['business']['nogaSection'],
      nogaDivision: stringValue(row.noga_division),
      activityDescription: stringValue(row.activity_description),
      nogaDetailedCode: stringValue(row.noga_detailed_code),
    },
    billing: {
      currency: 'CHF',
      iban: stringValue(row.iban),
      accountHolder: extraBilling?.accountHolder ?? stringValue(row.company_name),
      quotePrefix: stringValue(row.quote_prefix),
      invoicePrefix: stringValue(row.invoice_prefix),
      creditNotePrefix: stringValue(row.credit_note_prefix) || extraBilling?.creditNotePrefix || '',
      nextQuoteNumber: numberValue(row.quote_start_number) || extraBilling?.nextQuoteNumber || 1,
      nextInvoiceNumber: numberValue(row.invoice_start_number) || extraBilling?.nextInvoiceNumber || 1,
      nextCreditNoteNumber: numberValue(row.credit_note_start_number) || extraBilling?.nextCreditNoteNumber || 1,
      paymentTermsDays: numberValue(row.payment_terms_days),
      quoteValidityDays: extraBilling?.quoteValidityDays ?? numberValue(row.quote_validity_days),
      vatRatesBp: configuredVat.length ? configuredVat : defaultVat ? [defaultVat] : [],
      defaultFooter: extraBilling?.defaultFooter ?? '',
    },
    work: extra.work ?? { workWeekHours: 0, dailyHours: 0, roundingMinutes: 0, breakMinutes: 0, costCategories: [] },
    payroll: extra.payroll ?? {
      enabled: false,
      fiduciaryValidated: false,
      avsFund: '',
      accidentInsurer: '',
      pensionFund: '',
      dailyAllowanceInsurer: '',
      familyAllowanceFund: '',
      payrollCanton: '',
      employeeRates: [],
      employerRates: [],
    },
    backup: extra.backup ?? { automatic: false, folder: '', frequency: 'manual', retentionDaily: 0, retentionWeekly: 0, retentionMonthly: 0, recoveryConfirmed: false },
  };
}

const projectStatusFromRaw = (value: unknown): Project['status'] => {
  const status = stringValue(value);
  return ({ planifie: 'planned', en_cours: 'in_progress', en_pause: 'paused', termine: 'completed', cloture: 'closed' } as Record<string, Project['status']>)[status] ?? 'planned';
};
const quoteStatusFromRaw = (value: unknown): Quote['status'] => {
  const status = stringValue(value);
  return ({ brouillon: 'draft', emis: 'issued', accepte: 'accepted', refuse: 'refused', expire: 'expired' } as Record<string, Quote['status']>)[status] ?? 'draft';
};
const invoiceStatusFromRaw = (value: unknown): Invoice['status'] => {
  const status = stringValue(value);
  return ({ brouillon: 'draft', emise: 'issued', partiellement_payee: 'partially_paid', payee: 'paid', annulee: 'cancelled', en_retard: 'issued' } as Record<string, Invoice['status']>)[status] ?? 'draft';
};

function lineFromRaw(row: RawRecord): DocumentLine {
  return { id: stringValue(row.id), description: stringValue(row.description), quantity: numberValue(row.quantity), unit: stringValue(row.unit), unitPriceCents: numberValue(row.unit_price_cents), vatRateBp: numberValue(row.vat_bp) };
}

function frozenIssuerFromRaw(row: RawRecord, dataDir = ''): FrozenIssuer {
  const extra = parseExtra(row);
  return { companyName: stringValue(row.company_name), legalForm: stringValue(row.legal_form), ownerName: stringValue(row.owner_name), email: stringValue(row.email), phone: stringValue(row.phone), addressLine1: stringValue(row.address_line1), addressLine2: stringValue(row.address_line2), buildingNumber: stringValue(row.building_number) || extra.organization?.address?.buildingNumber || '', postalCode: stringValue(row.postal_code), city: stringValue(row.city), canton: stringValue(row.canton), country: stringValue(row.country), uidNumber: stringValue(row.uid_number), vatNumber: stringValue(row.vat_number), vatRegistered: boolValue(row.vat_registered), iban: stringValue(row.iban), bankName: stringValue(row.bank_name), currency: stringValue(row.currency) || 'CHF', logoPath: rebaseStoredBrandingPath(row.logo_path, dataDir) };
}

function frozenCustomerFromRaw(row: RawRecord): FrozenCustomer {
  return { id: stringValue(row.id), name: stringValue(row.name), company: stringValue(row.company), contactPerson: stringValue(row.contact_person), email: stringValue(row.email), phone: stringValue(row.phone), addressLine1: stringValue(row.address_line1), addressLine2: stringValue(row.address_line2), postalCode: stringValue(row.postal_code), city: stringValue(row.city), canton: stringValue(row.canton), country: stringValue(row.country) };
}

function storedQrBillFromRaw(value: unknown, fallbackInvoiceId = ''): StoredSwissQrBill | null {
  const row = recordValue(value);
  const inputRow = Object.keys(recordValue(row.input)).length ? recordValue(row.input) : parsedSnapshot(row.input_json);
  const payload = stringValue(row.payload);
  if (!inputRow || !payload) return null;
  let lines = Array.isArray(row.lines) ? row.lines.map(stringValue) : [];
  if (!lines.length && typeof row.lines_json === 'string') {
    try { const parsed: unknown = JSON.parse(row.lines_json); if (Array.isArray(parsed)) lines = parsed.map(stringValue); }
    catch { lines = []; }
  }
  return {
    invoiceId: stringValue(row.invoice_id) || fallbackInvoiceId,
    input: qrInputFromRaw(inputRow),
    payload,
    lines: lines.length ? lines : payload.split('\n'),
    referenceType: stringValue(row.reference_type) as StoredSwissQrBill['referenceType'],
    isQrIban: boolValue(row.is_qr_iban),
    characterCount: numberValue(row.character_count),
    byteCount: numberValue(row.byte_count),
    frozenAt: stringValue(row.frozen_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    frozen: boolValue(row.frozen) || Boolean(stringValue(row.frozen_at)),
  };
}

function documentSnapshotFromRaw(value: unknown, dataDir = ''): FrozenDocumentSnapshot | null {
  const root = parsedSnapshot(value);
  if (!root || stringValue(root.schema) !== 'helvichantier.document_snapshot.v1') return null;
  const document = recordValue(root.document);
  return {
    capturedAt: stringValue(root.captured_at), issuer: frozenIssuerFromRaw(recordValue(root.issuer), dataDir), customer: frozenCustomerFromRaw(recordValue(root.customer)),
    document: { id: stringValue(document.id), number: stringValue(document.number), clientId: stringValue(document.client_id), projectId: nullableString(document.project_id), quoteId: nullableString(document.quote_id), originalInvoiceId: nullableString(document.original_invoice_id), title: stringValue(document.title), type: stringValue(document.type), issueDate: stringValue(document.issue_date), validUntil: stringValue(document.valid_until), dueDate: stringValue(document.due_date), serviceDateFrom: stringValue(document.service_date_from), serviceDateTo: stringValue(document.service_date_to), currency: stringValue(document.currency) || 'CHF', notes: stringValue(document.notes), terms: stringValue(document.terms) },
    items: rawArray(root.items).map(lineFromRaw),
    qrBill: storedQrBillFromRaw(root.qr_bill, stringValue(document.id)),
  };
}

function normalizeWorkspace(raw: RawWorkspace, appState: AppState): Workspace {
  const quoteItems = raw.quote_items ?? [];
  const invoiceItems = raw.invoice_items ?? [];
  const invoiceQrBills = raw.invoice_qr_bills ?? [];
  const payslipItems = raw.payslip_items ?? [];
  const clients: Client[] = (raw.clients ?? []).map((row) => ({
    id: stringValue(row.id), name: stringValue(row.contact_person) || stringValue(row.name), company: stringValue(row.company), email: stringValue(row.email), phone: stringValue(row.phone),
    address: [stringValue(row.address_line1), stringValue(row.address_line2), [stringValue(row.postal_code), stringValue(row.city)].filter(Boolean).join(' '), stringValue(row.canton), stringValue(row.country)].filter(Boolean).join('\n'),
    addressLine1: stringValue(row.address_line1), addressLine2: stringValue(row.address_line2), buildingNumber: stringValue(row.address_line2), postalCode: stringValue(row.postal_code), city: stringValue(row.city), canton: stringValue(row.canton), country: stringValue(row.country),
    uidNumber: '', notes: stringValue(row.notes),
  }));
  const projects: Project[] = (raw.projects ?? []).map((row) => ({
    id: stringValue(row.id), clientId: stringValue(row.client_id), name: stringValue(row.name),
    address: [stringValue(row.address_line1), stringValue(row.address_line2), [stringValue(row.postal_code), stringValue(row.city)].filter(Boolean).join(' '), stringValue(row.canton)].filter(Boolean).join('\n'),
    status: projectStatusFromRaw(row.status), plannedStart: stringValue(row.planned_start_date), plannedEnd: stringValue(row.planned_end_date), actualStart: stringValue(row.actual_start_date), actualEnd: stringValue(row.actual_end_date), budgetCents: numberValue(row.budget_cents), plannedMinutes: numberValue(row.planned_minutes), notes: stringValue(row.notes) || stringValue(row.description),
  }));
  const quotes: Quote[] = (raw.quotes ?? []).map((row) => ({
    id: stringValue(row.id), number: stringValue(row.number), clientId: stringValue(row.client_id), projectId: stringValue(row.project_id) || null, title: stringValue(row.title), issueDate: stringValue(row.issue_date), validUntil: stringValue(row.valid_until), status: quoteStatusFromRaw(row.status),
    lines: quoteItems.filter((item) => stringValue(item.quote_id) === stringValue(row.id)).sort((a, b) => numberValue(a.position) - numberValue(b.position)).map(lineFromRaw), notes: stringValue(row.notes), createdAt: stringValue(row.created_at), snapshot: documentSnapshotFromRaw(row.snapshot_json, appState.data_dir),
  }));
  const invoices: Invoice[] = (raw.invoices ?? []).map((row) => {
    const snapshot = documentSnapshotFromRaw(row.snapshot_json, appState.data_dir);
    const qrBill = snapshot?.qrBill ?? storedQrBillFromRaw(invoiceQrBills.find((item) => stringValue(item.invoice_id) === stringValue(row.id)), stringValue(row.id));
    return {
      id: stringValue(row.id), number: stringValue(row.number), clientId: stringValue(row.client_id), projectId: stringValue(row.project_id) || null, quoteId: stringValue(row.quote_id) || null, originalInvoiceId: stringValue(row.original_invoice_id) || null, title: stringValue(row.title),
      type: ({ acompte: 'deposit', situation: 'progress', finale: 'final', avoir: 'credit_note' } as Record<string, Invoice['type']>)[stringValue(row.type)] ?? 'standard', issueDate: stringValue(row.issue_date), dueDate: stringValue(row.due_date), serviceDateFrom: stringValue(row.service_date_from), serviceDateTo: stringValue(row.service_date_to), status: invoiceStatusFromRaw(row.status),
      lines: invoiceItems.filter((item) => stringValue(item.invoice_id) === stringValue(row.id)).sort((a, b) => numberValue(a.position) - numberValue(b.position)).map(lineFromRaw), notes: stringValue(row.notes), createdAt: stringValue(row.created_at), snapshot, qrBill,
    };
  });
  const employees: Employee[] = (raw.employees ?? []).map((row) => ({
    id: stringValue(row.id), employeeNumber: stringValue(row.employee_number), name: stringValue(row.name), role: stringValue(row.role), email: stringValue(row.email), phone: stringValue(row.phone),
    address: [stringValue(row.address_line1), stringValue(row.address_line2), [stringValue(row.postal_code), stringValue(row.city)].filter(Boolean).join(' '), stringValue(row.canton)].filter(Boolean).join('\n'),
    addressLine1: stringValue(row.address_line1), addressLine2: stringValue(row.address_line2), postalCode: stringValue(row.postal_code), city: stringValue(row.city), canton: stringValue(row.canton), country: stringValue(row.country),
    birthDate: stringValue(row.birth_date), avsNumber: stringValue(row.social_security_number), employmentStart: stringValue(row.employment_start_date), employmentEnd: stringValue(row.employment_end_date), referenceAgeDate: stringValue(row.reference_age_date), avsAllowanceWaived: row.avs_allowance_waived === null || row.avs_allowance_waived === undefined ? null : boolValue(row.avs_allowance_waived), employmentRate: numberValue(row.employment_rate), salaryMode: numberValue(row.monthly_salary_cents) > 0 ? 'monthly' : 'hourly', grossSalaryCents: numberValue(row.monthly_salary_cents), hourlyCostCents: numberValue(row.hourly_rate_cents), iban: stringValue(row.iban), active: stringValue(row.status) !== 'inactif', notes: stringValue(row.notes),
  }));
  const timeEntries: TimeEntry[] = (raw.time_entries ?? []).map((row) => ({ id: stringValue(row.id), projectId: stringValue(row.project_id), employeeId: stringValue(row.employee_id), date: stringValue(row.date), minutes: numberValue(row.minutes), breakMinutes: numberValue(row.break_minutes), billable: boolValue(row.billable), billingRateCents: numberValue(row.billing_rate_cents), hourlyCostCents: numberValue(row.cost_rate_cents), note: stringValue(row.note), status: ({ approuve: 'approved', verrouille: 'locked' } as Record<string, TimeEntry['status']>)[stringValue(row.status)] ?? 'entered', createdAt: stringValue(row.created_at) }));
  const expenses: Expense[] = (raw.expenses ?? []).map((row) => ({ id: stringValue(row.id), projectId: stringValue(row.project_id), date: stringValue(row.date), supplier: stringValue(row.supplier), category: stringValue(row.category), reference: stringValue(row.reference), netCents: numberValue(row.net_cents), vatCents: numberValue(row.vat_cents), totalCents: numberValue(row.total_cents), reimbursable: boolValue(row.reimbursable), note: stringValue(row.note) }));
  const payslips: Payslip[] = (raw.payslips ?? []).map((row) => ({
    id: stringValue(row.id), employeeId: stringValue(row.employee_id), period: stringValue(row.period), status: ({ brouillon: 'draft', a_controler: 'incomplete', valide: 'validated', comptabilise: 'posted', paye: 'paid' } as Record<string, Payslip['status']>)[stringValue(row.status)] ?? 'incomplete',
    lines: payslipItems.filter((item) => stringValue(item.payslip_id) === stringValue(row.id)).sort((a, b) => numberValue(a.position) - numberValue(b.position)).map((item) => ({ id: stringValue(item.id), label: stringValue(item.label), kind: payslipLineKindFromRaw(item.kind), amountCents: numberValue(item.amount_cents), postingAccountId: stringValue(item.posting_account_id), expenseAccountId: stringValue(item.expense_account_id) })), paymentDate: stringValue(row.payment_date), paymentReference: stringValue(row.payment_reference), paymentJournalEntryId: stringValue(row.payment_journal_entry_id), notes: stringValue(row.notes), createdAt: stringValue(row.created_at), snapshot: payslipSnapshotFromRaw(row.snapshot_json, appState.data_dir),
  }));
  const payrollImports = (raw.payroll_document_imports ?? []).map(payrollImportFromRaw);
  const employeePayrollTemplates = (raw.employee_payroll_templates ?? []).map(employeePayrollTemplateFromRaw);
  const payments: Payment[] = (raw.payments ?? []).map((row) => ({ id: stringValue(row.id), invoiceId: stringValue(row.invoice_id), date: stringValue(row.date), amountCents: numberValue(row.amount_cents), method: stringValue(row.method), reference: stringValue(row.reference) }));
  const timer = raw.active_timer;
  return {
    schemaVersion: 1, onboardingCompleted: appState.onboarding_completed, activityProfileRequired: boolValue(appState.activity_profile_required), settings: settingsFromRaw(raw.settings, appState.data_dir), clients, projects, quotes, invoices, payments, employees, timeEntries,
    activeTimer: timer ? { projectId: stringValue(timer.project_id), employeeId: stringValue(timer.employee_id), startedAt: stringValue(timer.started_at), note: stringValue(timer.note), billable: boolValue(timer.billable), billingRateCents: numberValue(timer.billing_rate_cents), hourlyCostCents: numberValue(timer.cost_rate_cents) } : null,
    expenses, payslips, payrollImports, employeePayrollTemplates, backupStatus: { lastSuccessAt: null, lastPath: null, nextScheduledAt: null },
  };
}

function emptyWorkspace(): Workspace {
  return { schemaVersion: 1, onboardingCompleted: false, activityProfileRequired: true, settings: null, clients: [], projects: [], quotes: [], invoices: [], payments: [], employees: [], timeEntries: [], activeTimer: null, expenses: [], payslips: [], payrollImports: [], employeePayrollTemplates: [], backupStatus: { lastSuccessAt: null, lastPath: null, nextScheduledAt: null } };
}

async function loadWorkspace(): Promise<Workspace> {
  const appState = appStateFromRaw(await invoke<RawRecord>('get_app_state'));
  if (!appState.onboarding_completed) return emptyWorkspace();
  return normalizeWorkspace(await invoke<RawWorkspace>('get_workspace'), appState);
}

function backendExtra(settings: AppSettings): string {
  return JSON.stringify({ organization: { website: settings.organization.website, address: { buildingNumber: settings.organization.address.buildingNumber ?? '' } }, billing: { accountHolder: settings.billing.accountHolder, creditNotePrefix: settings.billing.creditNotePrefix, nextQuoteNumber: settings.billing.nextQuoteNumber, nextInvoiceNumber: settings.billing.nextInvoiceNumber, nextCreditNoteNumber: settings.billing.nextCreditNoteNumber, quoteValidityDays: settings.billing.quoteValidityDays, vatRatesBp: settings.billing.vatRatesBp, defaultFooter: settings.billing.defaultFooter }, work: settings.work, payroll: settings.payroll, backup: settings.backup });
}

function settingsToBackend(settings: AppSettings): RawRecord {
  const street = settings.organization.address.street.split('\n');
  return {
    company_name: settings.organization.legalName, legal_form: settings.organization.legalForm, owner_name: settings.organization.contactName, email: settings.organization.email, phone: settings.organization.phone,
    address_line1: street[0] ?? '', address_line2: street.slice(1).join(' '), postal_code: settings.organization.address.postalCode, city: settings.organization.address.city, canton: settings.organization.address.canton, country: settings.organization.address.country,
    uid_number: settings.organization.uidNumber, vat_number: settings.organization.vatNumber, vat_registered: settings.organization.vatRegistered, default_vat_bp: settings.billing.vatRatesBp[0] ?? 0, iban: settings.billing.iban, bank_name: settings.billing.accountHolder, currency: 'CHF', quote_prefix: settings.billing.quotePrefix, invoice_prefix: settings.billing.invoicePrefix, credit_note_prefix: settings.billing.creditNotePrefix, quote_start_number: settings.billing.nextQuoteNumber, invoice_start_number: settings.billing.nextInvoiceNumber, credit_note_start_number: settings.billing.nextCreditNoteNumber, payment_terms_days: settings.billing.paymentTermsDays, quote_validity_days: settings.billing.quoteValidityDays, default_hourly_rate_cents: 0, logo_path: settings.organization.logoPath ?? '', noga_section: settings.business.nogaSection, noga_division: settings.business.nogaDivision, activity_description: settings.business.activityDescription, noga_detailed_code: settings.business.nogaDetailedCode || null, extra_settings_json: backendExtra(settings),
  };
}

const entityToBackend: Record<EntityKind, string> = { clients: 'clients', projects: 'projects', quotes: 'quotes', invoices: 'invoices', employees: 'employees', timeEntries: 'time_entries', expenses: 'expenses', payslips: 'payslips' };
const statusToBackend: Record<string, string> = { planned: 'planifie', in_progress: 'en_cours', paused: 'en_pause', completed: 'termine', closed: 'cloture', draft: 'brouillon', issued: 'emis', accepted: 'accepte', refused: 'refuse', expired: 'expire', partially_paid: 'partiellement_payee', paid: 'payee', cancelled: 'annulee', entered: 'saisi', approved: 'approuve', locked: 'verrouille', incomplete: 'a_controler', validated: 'valide' };
const snakeKey = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
function toBackendData(data: Record<string, unknown>): RawRecord {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [snakeKey(key), key === 'status' && typeof value === 'string' ? statusToBackend[value] ?? value : value]));
}
const createRecord = (entity: string, data: RawRecord) => invoke<RawRecord>('create_record', { entity, data });

async function saveDocument(entity: 'quotes' | 'invoices', data: Record<string, unknown>, lines: DocumentLine[], existing?: Quote | Invoice): Promise<Workspace> {
  const previousLines = existing?.lines ?? [];
  await invoke('save_document_with_items', { input: {
    entity,
    id: existing?.id ?? null,
    data: toBackendData(data),
    items: lines.map((line) => ({ id: previousLines.some((previous) => previous.id === line.id) ? line.id : null, description: line.description, quantity: line.quantity, unit: line.unit, unit_price_cents: line.unitPriceCents, discount_bp: 0, vat_bp: line.vatRateBp })),
  } });
  return loadWorkspace();
}

async function chooseFile(options: OpenDialogOptions & { multiple?: false }): Promise<string | null> {
  const dialog = await import('@tauri-apps/plugin-dialog');
  return dialog.open(options);
}

async function chooseFiles(options: OpenDialogOptions & { multiple: true }): Promise<string[]> {
  const dialog = await import('@tauri-apps/plugin-dialog');
  const result = await dialog.open(options);
  return result ?? [];
}

async function chooseSaveFile(options: SaveDialogOptions): Promise<string | null> {
  const dialog = await import('@tauri-apps/plugin-dialog');
  return dialog.save(options);
}

function payrollImportDraftToRaw(draft: PayrollImportDraft): RawRecord {
  return {
    employee: {
      employee_number: draft.employee.employeeNumber,
      name: draft.employee.name,
      role: draft.employee.role,
      address_line1: draft.employee.addressLine1,
      address_line2: draft.employee.addressLine2,
      postal_code: draft.employee.postalCode,
      city: draft.employee.city,
      canton: draft.employee.canton,
      birth_date: draft.employee.birthDate,
      avs_number: draft.employee.avsNumber,
      iban: draft.employee.iban,
      employment_rate: draft.employee.employmentRate,
      salary_mode: draft.employee.salaryMode,
    },
    period: draft.period,
    payment_date: draft.paymentDate,
    gross_cents: draft.grossCents,
    net_cents: draft.netCents,
    lines: draft.lines.map((line) => ({ label: line.label, kind: line.kind, amount_cents: line.amountCents, recurring: line.recurring, confidence_bp: line.confidenceBp })),
    warnings: draft.warnings,
  };
}

const nullableString = (value: unknown): string | null => stringValue(value) || null;
const rawArray = (value: unknown, key?: string): RawRecord[] => {
  if (Array.isArray(value)) return value.filter((item): item is RawRecord => Boolean(item && typeof item === 'object'));
  if (key && value && typeof value === 'object') return rawArray((value as RawRecord)[key]);
  return [];
};

export function accountingFallbacksFromPostPayslip(value: unknown): AccountingFallback[] {
  const posted = recordValue(value);
  const journal = recordValue(posted.journal);
  return rawArray(journal.accounting_fallbacks).map((row) => ({
    contribution: stringValue(row.contribution),
    field: stringValue(row.field),
    accountId: stringValue(row.account_id),
    reason: stringValue(row.reason),
  }));
}

function accountFromRaw(row: RawRecord): Account {
  return { id: stringValue(row.id), code: stringValue(row.code), name: stringValue(row.name), accountType: stringValue(row.account_type) as Account['accountType'], normalBalance: stringValue(row.normal_balance) as Account['normalBalance'], reportSection: stringValue(row.report_section) as Account['reportSection'], active: boolValue(row.active) };
}

function accountingSettingsFromRaw(row: RawRecord | null | undefined): AccountingSettings {
  return {
    enabled: boolValue(row?.enabled), arAccountId: stringValue(row?.ar_account_id), revenueAccountId: stringValue(row?.revenue_account_id), vatPayableAccountId: stringValue(row?.vat_payable_account_id), bankAccountId: stringValue(row?.bank_account_id), expenseAccountId: stringValue(row?.expense_account_id), vatReceivableAccountId: stringValue(row?.vat_receivable_account_id), wagesExpenseAccountId: stringValue(row?.wages_expense_account_id), wagesPayableAccountId: stringValue(row?.wages_payable_account_id), socialExpenseAccountId: stringValue(row?.social_expense_account_id), socialPayableAccountId: stringValue(row?.social_payable_account_id),
  };
}

function journalEntryFromRaw(row: RawRecord): JournalEntry {
  return { id: stringValue(row.id), number: stringValue(row.number), entryDate: stringValue(row.entry_date), description: stringValue(row.description), sourceType: stringValue(row.source_type), sourceId: stringValue(row.source_id), sourceEvent: stringValue(row.source_event), status: 'posted', reversalOf: nullableString(row.reversal_of) };
}

function journalLineFromRaw(row: RawRecord): JournalLine {
  return { id: stringValue(row.id), journalEntryId: stringValue(row.journal_entry_id), accountId: stringValue(row.account_id), accountCode: stringValue(row.account_code), accountName: stringValue(row.account_name), entryNumber: stringValue(row.entry_number), entryDate: stringValue(row.entry_date), debitCents: numberValue(row.debit_cents), creditCents: numberValue(row.credit_cents), currency: stringValue(row.currency), memo: stringValue(row.memo), projectId: nullableString(row.project_id), clientId: nullableString(row.client_id), employeeId: nullableString(row.employee_id) };
}

function statementRowFromRaw(row: RawRecord): StatementRow {
  return { id: stringValue(row.id), code: stringValue(row.code), name: stringValue(row.name), accountType: stringValue(row.account_type) as StatementRow['accountType'], normalBalance: stringValue(row.normal_balance) as StatementRow['normalBalance'], reportSection: stringValue(row.report_section) as StatementRow['reportSection'], debitCents: numberValue(row.debit_cents), creditCents: numberValue(row.credit_cents), amountCents: numberValue(row.amount_cents), previousDebitCents: numberValue(row.previous_debit_cents), previousCreditCents: numberValue(row.previous_credit_cents), previousAmountCents: numberValue(row.previous_amount_cents) };
}

function statementScopeFromRaw(value: unknown): StatementScope {
  const row = recordValue(value);
  return { dateFrom: stringValue(row.date_from), dateTo: stringValue(row.date_to), previousDateFrom: stringValue(row.previous_date_from), previousDateTo: stringValue(row.previous_date_to), comparisonLabel: stringValue(row.comparison_label), comparisonSource: stringValue(row.comparison_source) as StatementScope['comparisonSource'], previousHasActivity: boolValue(row.previous_has_activity) };
}

function reportCurrencyFromRaw(value: unknown): ReportCurrency {
  const row = recordValue(value);
  return { baseCurrency: stringValue(row.base_currency), currencies: Array.isArray(row.currencies) ? row.currencies.map(stringValue).filter(Boolean) : [], singleCurrency: boolValue(row.single_currency), exchangeRatesApplied: boolValue(row.exchange_rates_applied) };
}

function numberRecord(value: unknown): Record<string, number> { if (!value || typeof value !== 'object') return {}; return Object.fromEntries(Object.entries(value as RawRecord).map(([key, amount]) => [key, numberValue(amount)])); }

function reminderTemplateFromRaw(row: RawRecord): ReminderTemplate {
  return { id: stringValue(row.id), level: numberValue(row.level), name: stringValue(row.name), subject: stringValue(row.subject), body: stringValue(row.body), daysAfterDue: numberValue(row.days_after_due), active: boolValue(row.active) };
}

function reminderFromRaw(row: RawRecord): Reminder {
  return { id: stringValue(row.id), invoiceId: stringValue(row.invoice_id), templateId: nullableString(row.template_id), level: numberValue(row.level), scheduledDate: stringValue(row.scheduled_date), status: stringValue(row.status) as ReminderStatus, subject: stringValue(row.subject), body: stringValue(row.body), notes: stringValue(row.notes), invoiceNumber: stringValue(row.invoice_number), invoiceTitle: stringValue(row.invoice_title), dueDate: stringValue(row.due_date), clientName: stringValue(row.client_name), currency: stringValue(row.currency) || 'CHF', invoiceTotalCents: numberValue(row.invoice_total_cents), balanceCents: numberValue(row.balance_cents) };
}

function contributionFromRaw(row: RawRecord): PayrollContributionDefinition {
  return { id: stringValue(row.id) || stringValue(row.definition_id), code: stringValue(row.code), label: stringValue(row.label), category: stringValue(row.category) as PayrollContributionDefinition['category'], side: stringValue(row.side) as PayrollContributionDefinition['side'], calculationKind: stringValue(row.calculation_kind) as PayrollContributionDefinition['calculationKind'], rateBp: row.rate_bp === null || row.rate_bp === undefined ? null : numberValue(row.rate_bp), fixedAmountCents: row.fixed_amount_cents === null || row.fixed_amount_cents === undefined ? null : numberValue(row.fixed_amount_cents), annualCeilingCents: row.annual_ceiling_cents === null || row.annual_ceiling_cents === undefined ? null : numberValue(row.annual_ceiling_cents), basisKind: stringValue(row.basis_kind) as PayrollContributionDefinition['basisKind'], source: stringValue(row.source), effectiveFrom: stringValue(row.effective_from), effectiveTo: stringValue(row.effective_to), active: boolValue(row.active), liabilityAccountId: stringValue(row.liability_account_id), expenseAccountId: stringValue(row.expense_account_id) };
}

function payslipContributionFromRaw(row: RawRecord): PayslipContributionSnapshot {
  return {
    id: stringValue(row.id),
    payslipId: stringValue(row.payslip_id),
    definitionId: stringValue(row.definition_id),
    payslipItemId: stringValue(row.payslip_item_id),
    label: stringValue(row.label),
    category: stringValue(row.category) as PayslipContributionSnapshot['category'],
    side: stringValue(row.side) as PayslipContributionSnapshot['side'],
    calculationKind: stringValue(row.calculation_kind) as PayslipContributionSnapshot['calculationKind'],
    basisKind: stringValue(row.basis_kind) as PayslipContributionSnapshot['basisKind'],
    basisCents: numberValue(row.basis_cents),
    yearToDateBasisCents: row.year_to_date_basis_cents === null || row.year_to_date_basis_cents === undefined ? null : numberValue(row.year_to_date_basis_cents),
    rateBp: row.rate_bp === null || row.rate_bp === undefined ? null : numberValue(row.rate_bp),
    fixedAmountCents: row.fixed_amount_cents === null || row.fixed_amount_cents === undefined ? null : numberValue(row.fixed_amount_cents),
    annualCeilingCents: row.annual_ceiling_cents === null || row.annual_ceiling_cents === undefined ? null : numberValue(row.annual_ceiling_cents),
    amountCents: numberValue(row.amount_cents),
    source: stringValue(row.source),
    effectiveFrom: stringValue(row.effective_from),
    effectiveTo: stringValue(row.effective_to),
    liabilityAccountId: stringValue(row.liability_account_id),
    expenseAccountId: stringValue(row.expense_account_id),
    createdAt: stringValue(row.created_at),
  };
}

function frozenEmployeeFromRaw(row: RawRecord): FrozenEmployee {
  return { id: stringValue(row.id), employeeNumber: stringValue(row.employee_number), name: stringValue(row.name), role: stringValue(row.role), address: [stringValue(row.address_line1), stringValue(row.address_line2), [stringValue(row.postal_code), stringValue(row.city)].filter(Boolean).join(' '), stringValue(row.canton), stringValue(row.country)].filter(Boolean).join('\n'), avsNumber: stringValue(row.social_security_number), iban: stringValue(row.iban), employmentRate: numberValue(row.employment_rate) };
}

function payslipSnapshotFromRaw(value: unknown, dataDir = ''): FrozenPayslipSnapshot | null {
  const root = parsedSnapshot(value);
  if (!root || stringValue(root.schema) !== 'helvichantier.payslip_snapshot.v1') return null;
  const payslip = recordValue(root.payslip);
  return { capturedAt: stringValue(root.captured_at), issuer: frozenIssuerFromRaw(recordValue(root.issuer), dataDir), employee: frozenEmployeeFromRaw(recordValue(root.employee)), period: stringValue(payslip.period), paymentDate: stringValue(payslip.payment_date), notes: stringValue(payslip.notes), items: rawArray(root.items).map((item) => ({ id: stringValue(item.id), label: stringValue(item.label), kind: payslipLineKindFromRaw(item.kind), amountCents: numberValue(item.amount_cents), postingAccountId: stringValue(item.posting_account_id), expenseAccountId: stringValue(item.expense_account_id) })), contributions: rawArray(root.contributions).map(payslipContributionFromRaw) };
}

function qrInputToRaw(input: SwissQrBillInput): RawRecord {
  const party = (value: SwissQrBillInput['creditor']) => ({ name: value.name, street: value.street, building_number: value.buildingNumber, postal_code: value.postalCode, city: value.city, country: value.country });
  return { iban: input.iban, creditor: party(input.creditor), amount_cents: input.amountCents, currency: input.currency, debtor: input.debtor ? party(input.debtor) : null, reference_type: input.referenceType, reference: input.reference, unstructured_message: input.unstructuredMessage, bill_information: input.billInformation, alternative_procedures: input.alternativeProcedures };
}

function qrInputFromRaw(row: RawRecord): SwissQrBillInput {
  const party = (value: unknown) => { const item = value && typeof value === 'object' ? value as RawRecord : {}; return { name: stringValue(item.name), street: stringValue(item.street), buildingNumber: stringValue(item.building_number), postalCode: stringValue(item.postal_code), city: stringValue(item.city), country: stringValue(item.country) }; };
  return { iban: stringValue(row.iban), creditor: party(row.creditor), amountCents: row.amount_cents === null || row.amount_cents === undefined ? undefined : numberValue(row.amount_cents), currency: stringValue(row.currency) as 'CHF' | 'EUR', debtor: row.debtor ? party(row.debtor) : undefined, referenceType: stringValue(row.reference_type) as SwissQrBillInput['referenceType'], reference: stringValue(row.reference), unstructuredMessage: stringValue(row.unstructured_message), billInformation: stringValue(row.bill_information), alternativeProcedures: Array.isArray(row.alternative_procedures) ? row.alternative_procedures.map(stringValue) : [] };
}

const periodFilterToRaw = (filter: PeriodFilter): RawRecord => ({ date_from: filter.dateFrom || null, date_to: filter.dateTo || null });

export const desktopApi = {
  loadWorkspace,
  async getNogaCatalog(): Promise<NogaCatalog> {
    const raw = await invoke<RawRecord>('get_noga_catalog');
    return { version: stringValue(raw.version), source: stringValue(raw.source), sections: rawArray(raw.sections).map((section) => ({ code: stringValue(section.code) as NogaCatalog['sections'][number]['code'], label: stringValue(section.label), divisions: rawArray(section.divisions).map((division) => ({ code: stringValue(division.code), label: stringValue(division.label) })) })) };
  },
  async getLicenseState(): Promise<LicenseState> { return licenseStateFromRaw(await invoke<RawRecord>('get_license_state')); },
  async installLicenseToken(token: string): Promise<LicenseState> { return licenseStateFromRaw(await invoke<RawRecord>('install_license_token', { token })); },
  async getSecureUpdatePolicy(): Promise<SecureUpdaterPolicy> {
    return secureUpdaterPolicyFromRaw(await invoke<RawRecord>('get_secure_update_policy'));
  },
  async checkSecureUpdate(): Promise<SecureUpdateMetadata | null> {
    const raw = await invoke<RawRecord | null>('check_secure_update');
    return raw ? secureUpdateMetadataFromRaw(raw) : null;
  },
  async installSecureUpdate(onEvent: (event: SecureUpdateEvent) => void): Promise<void> {
    const channel = new Channel<unknown>();
    channel.onmessage = (value) => {
      const event = secureUpdateEventFromRaw(value);
      if (event) onEvent(event);
    };
    await invoke('install_secure_update', { onEvent: channel });
  },
  async validateOnboarding(settings: OnboardingPayload): Promise<OnboardingValidationResult> {
    return onboardingValidationFromRaw(await invoke<RawRecord>('validate_onboarding', { input: settingsToBackend(settings) }));
  },
  async completeOnboarding(settings: OnboardingPayload) {
    let response: RawRecord;
    try {
      response = recordValue(await invoke<RawRecord>('complete_onboarding', { input: settingsToBackend(settings) }));
    } catch (reason) {
      try {
        const recovered = await loadWorkspace();
        if (recovered.onboardingCompleted) return recovered;
      } catch {
        // Preserve the original completion error when recovery also fails.
      }
      throw reason;
    }
    const appState = appStateFromRaw(response.app_state ?? response.appState);
    const workspace = recordValue(response.workspace);
    if (!appState.onboarding_completed || !Object.keys(workspace).length) {
      const recovered = await loadWorkspace();
      if (recovered.onboardingCompleted) return recovered;
      throw new Error('La finalisation locale a renvoyé une réponse incomplète. Aucune donnée partielle n’a été conservée.');
    }
    return normalizeWorkspace(workspace as RawWorkspace, appState);
  },
  async saveSettings(settings: AppSettings) { await invoke('update_settings', { data: settingsToBackend(settings) }); return loadWorkspace(); },
  async stageCompanyLogo(sourcePath: string) { return invoke<string>('stage_company_logo', { sourcePath }); },
  async createEntity<T extends Record<string, unknown>>(entity: EntityKind, data: T) { await createRecord(entityToBackend[entity], toBackendData(data)); return loadWorkspace(); },
  async updateEntity<T extends Record<string, unknown>>(entity: EntityKind, id: string, data: T) { await invoke('update_record', { entity: entityToBackend[entity], id, data: toBackendData(data) }); return loadWorkspace(); },
  async archiveEntity(entity: EntityKind, id: string) { await invoke('delete_record', { entity: entityToBackend[entity], id }); return loadWorkspace(); },
  saveDocument,
  async issueDocument(entity: 'quotes' | 'invoices', id: string, issueDate?: string, dueDate?: string) {
    if (entity === 'quotes') await invoke('issue_quote', { id, issueDate, validUntil: dueDate });
    else await invoke('issue_invoice', { id, issueDate, dueDate });
    return loadWorkspace();
  },
  async updateQuoteStatus(id: string, status: 'accepted' | 'refused' | 'expired') {
    await invoke('update_quote_status', { id, status });
    return loadWorkspace();
  },
  async convertQuote(quote: Quote) {
    await invoke('convert_quote_to_invoice', { input: { quote_id: quote.id, title: quote.title } });
    return loadWorkspace();
  },
  async addPayment(invoiceId: string, data: Record<string, unknown>) { await invoke('record_payment', { input: { invoice_id: invoiceId, ...toBackendData(data) } }); return loadWorkspace(); },
  async savePayslip(data: Record<string, unknown>, lines: PayslipLine[], existing?: Payslip) {
    let payslipId = existing?.id;
    if (payslipId) await invoke('update_record', { entity: 'payslips', id: payslipId, data: toBackendData(data) });
    else payslipId = stringValue((await createRecord('payslips', toBackendData(data))).id);
    if (!payslipId) throw new Error('La fiche de salaire locale n’a pas pu être identifiée.');
    const previous = existing?.lines ?? [];
    const retained = new Set(lines.filter((line) => previous.some((old) => old.id === line.id)).map((line) => line.id));
    for (const old of previous) if (!retained.has(old.id)) await invoke('delete_record', { entity: 'payslip_items', id: old.id });
    for (const [position, line] of lines.entries()) {
      const lineData = { payslip_id: payslipId, position, label: line.label, kind: line.kind, amount_cents: line.amountCents, posting_account_id: line.postingAccountId || null, expense_account_id: line.expenseAccountId || null };
      if (previous.some((old) => old.id === line.id)) await invoke('update_record', { entity: 'payslip_items', id: line.id, data: lineData });
      else await createRecord('payslip_items', lineData);
    }
    return loadWorkspace();
  },
  async savePayslipWithContributions(data: Record<string, unknown>, lines: PayslipLine[], existing: Payslip | undefined, period: string, selections: PayrollContributionSelection[]) {
    await invoke('save_payslip_with_contributions', { input: {
      id: existing?.id ?? null,
      employee_id: String(data.employeeId ?? ''),
      period,
      status: statusToBackend[String(data.status ?? 'incomplete')] ?? 'a_controler',
      payment_date: String(data.paymentDate ?? '') || null,
      notes: String(data.notes ?? '') || null,
      lines: lines.map((line) => ({ id: existing?.lines.some((candidate) => candidate.id === line.id) ? line.id : null, label: line.label, kind: line.kind, amount_cents: line.amountCents, posting_account_id: line.postingAccountId || null, expense_account_id: line.expenseAccountId || null })),
      contributions: selections.map((item) => ({ definition_id: item.definitionId, basis_cents: item.basisCents ?? null, year_to_date_basis_cents: item.yearToDateBasisCents ?? null })),
    } });
    return loadWorkspace();
  },
  async startTimer(data: Record<string, unknown>) { await invoke('start_timer', { input: toBackendData(data) }); return loadWorkspace(); },
  async stopTimer() { await invoke('stop_timer'); return loadWorkspace(); },
  async createBackup(destination?: string) { const path = await invoke<string>('create_backup', { destination }); return { workspace: await loadWorkspace(), path }; },
  chooseRestoreFile: () => chooseFile({ multiple: false, directory: false, title: 'Choisir une sauvegarde Elyko', filters: [{ name: 'Sauvegarde Elyko', extensions: ['elyko', 'hchantier'] }] }),
  async restoreBackup(source: string) { await invoke<AppState>('restore_backup', { source }); return loadWorkspace(); },
  async exportData(format: 'json' | 'csv') { if (format !== 'json') throw new Error('L’export CSV sera disponible depuis chaque liste.'); return { path: await invoke<string>('export_json', {}) }; },
  async printDocument(entity: 'quotes' | 'invoices' | 'payslips', id: string) { window.print(); return { entity, id }; },
  chooseBackupFolder: () => chooseFile({ directory: true, multiple: false, title: 'Choisir le dossier de sauvegarde' }),
  chooseLogo: () => chooseFile({ multiple: false, directory: false, title: 'Choisir le logo', filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }),
  choosePayrollDocuments: () => chooseFiles({ multiple: true, directory: false, title: 'Ajouter des fiches de salaire', filters: [{ name: 'Fiches de salaire', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'] }] }),
  async stagePayrollDocuments(paths: string[]): Promise<PayrollDocumentImport[]> {
    const raw = await invoke<RawRecord>('stage_payroll_documents', { input: { paths } });
    return rawArray(raw, 'imports').map(payrollImportFromRaw);
  },
  async listPayrollDocumentImports(): Promise<PayrollDocumentImport[]> {
    const raw = await invoke<RawRecord>('list_payroll_document_imports');
    return rawArray(raw, 'imports').map(payrollImportFromRaw);
  },
  async getPayrollDocumentPreview(id: string): Promise<{ mimeType: string; dataBase64: string }> {
    const raw = await invoke<RawRecord>('get_payroll_document_preview', { id });
    const mimeType = stringValue(raw.mime_type);
    const dataBase64 = stringValue(raw.data_base64);
    if (!mimeType || !dataBase64) throw new Error("L’aperçu local du document est incomplet.");
    return { mimeType, dataBase64 };
  },
  async updatePayrollImportDraft(id: string, draft: PayrollImportDraft, extractionEngine: string, engineVersion: string, confidenceBp: number): Promise<PayrollDocumentImport> {
    const row = await invoke<RawRecord>('update_payroll_import_draft', { input: { id, draft: payrollImportDraftToRaw(draft), extraction_engine: extractionEngine, engine_version: engineVersion || null, confidence_bp: confidenceBp } });
    return payrollImportFromRaw(row);
  },
  async confirmPayrollDocumentImport(id: string, draft: PayrollImportDraft, employeeId?: string, replaceExistingTemplate = false): Promise<Workspace> {
    await invoke('confirm_payroll_document_import', { input: { id, employee_id: employeeId || null, replace_existing_template: replaceExistingTemplate, draft: payrollImportDraftToRaw(draft) } });
    return loadWorkspace();
  },
  async rejectPayrollDocumentImport(id: string): Promise<Workspace> {
    await invoke('reject_payroll_document_import', { id });
    return loadWorkspace();
  },
  async listAccounts() { return rawArray(await invoke<unknown>('list_accounts')).map(accountFromRaw); },
  async upsertAccount(input: Omit<Account, 'id'> & { id?: string }) {
    await invoke('upsert_account', { input: { id: input.id || null, code: input.code, name: input.name, account_type: input.accountType, normal_balance: input.normalBalance, report_section: input.reportSection, active: input.active } });
  },
  async deleteAccount(id: string) { await invoke('delete_account', { id }); },
  async getAccountingSettings() { const raw = await invoke<RawRecord | null>('get_accounting_settings'); return accountingSettingsFromRaw(raw); },
  async listAccountingPeriods(): Promise<AccountingPeriod[]> { return rawArray(await invoke<unknown>('list_accounting_periods')).map((row) => ({ id: stringValue(row.id), name: stringValue(row.name), dateFrom: stringValue(row.date_from), dateTo: stringValue(row.date_to), status: stringValue(row.status) as AccountingPeriod['status'], closedAt: stringValue(row.closed_at), createdAt: stringValue(row.created_at), updatedAt: stringValue(row.updated_at) })); },
  async upsertAccountingPeriod(input: { id?: string; name: string; dateFrom: string; dateTo: string }) { await invoke('upsert_accounting_period', { input: { id: input.id || null, name: input.name, date_from: input.dateFrom, date_to: input.dateTo } }); },
  async closeAccountingPeriod(id: string) { await invoke('close_accounting_period', { id }); },
  async configureAccounting(settings: AccountingSettings) {
    await invoke('configure_accounting', { input: { enabled: settings.enabled, ar_account_id: settings.arAccountId || null, revenue_account_id: settings.revenueAccountId || null, vat_payable_account_id: settings.vatPayableAccountId || null, bank_account_id: settings.bankAccountId || null, expense_account_id: settings.expenseAccountId || null, vat_receivable_account_id: settings.vatReceivableAccountId || null, wages_expense_account_id: settings.wagesExpenseAccountId || null, wages_payable_account_id: settings.wagesPayableAccountId || null, social_expense_account_id: settings.socialExpenseAccountId || null, social_payable_account_id: settings.socialPayableAccountId || null } });
  },
  async postManualJournalEntry(input: { entryDate: string; description: string; lines: Array<{ accountId: string; debitCents: number; creditCents: number; memo?: string; projectId?: string; clientId?: string; employeeId?: string }> }) {
    await invoke('post_manual_journal_entry', { input: { entry_date: input.entryDate, description: input.description, currency: 'CHF', lines: input.lines.map((line) => ({ account_id: line.accountId, debit_cents: line.debitCents, credit_cents: line.creditCents, memo: line.memo || null, project_id: line.projectId || null, client_id: line.clientId || null, employee_id: line.employeeId || null })) } });
  },
  async reverseJournalEntry(id: string, entryDate: string, description?: string) { await invoke('reverse_journal_entry', { id, entryDate, description: description || null }); },
  async getJournal(filter: PeriodFilter): Promise<JournalReport> { const raw = await invoke<RawRecord>('get_journal', { filter: periodFilterToRaw(filter) }); return { entries: rawArray(raw.entries).map(journalEntryFromRaw), lines: rawArray(raw.lines).map(journalLineFromRaw) }; },
  async getLedger(accountId: string, filter: PeriodFilter): Promise<LedgerReport> { const raw = await invoke<RawRecord>('get_ledger', { input: { account_id: accountId, ...periodFilterToRaw(filter) } }); return { account: accountFromRaw(raw.account as RawRecord), lines: rawArray(raw.lines).map(journalLineFromRaw), debitCents: numberValue(raw.debit_cents), creditCents: numberValue(raw.credit_cents), netDebitCents: numberValue(raw.net_debit_cents) }; },
  async getTrialBalance(filter: PeriodFilter): Promise<TrialBalanceReport> { const raw = await invoke<RawRecord>('get_trial_balance', { filter: periodFilterToRaw(filter) }); const rows: TrialBalanceRow[] = rawArray(raw.rows).map((row) => ({ ...accountFromRaw(row), debitCents: numberValue(row.debit_cents), creditCents: numberValue(row.credit_cents), debitBalanceCents: numberValue(row.debit_balance_cents), creditBalanceCents: numberValue(row.credit_balance_cents) })); return { rows, debitCents: numberValue(raw.debit_cents), creditCents: numberValue(raw.credit_cents), balanced: boolValue(raw.balanced) }; },
  async getBalanceSheet(filter: PeriodFilter): Promise<BalanceSheetReport> { const raw = await invoke<RawRecord>('get_balance_sheet', { filter: periodFilterToRaw(filter) }); return { asOf: stringValue(raw.as_of), exerciseFrom: stringValue(raw.exercise_from), scope: statementScopeFromRaw(raw.scope), currency: reportCurrencyFromRaw(raw.currency), rows: rawArray(raw.rows).map(statementRowFromRaw), sections: numberRecord(raw.sections), previousSections: numberRecord(raw.previous_sections), assetsCents: numberValue(raw.assets_cents), liabilitiesCents: numberValue(raw.liabilities_cents), equityCents: numberValue(raw.equity_cents), currentResultCents: numberValue(raw.current_result_cents), unallocatedPriorResultsCents: numberValue(raw.unallocated_prior_results_cents), balanced: boolValue(raw.balanced), previousAssetsCents: numberValue(raw.previous_assets_cents), previousLiabilitiesCents: numberValue(raw.previous_liabilities_cents), previousEquityCents: numberValue(raw.previous_equity_cents), previousCurrentResultCents: numberValue(raw.previous_current_result_cents), previousUnallocatedPriorResultsCents: numberValue(raw.previous_unallocated_prior_results_cents), previousBalanced: boolValue(raw.previous_balanced) }; },
  async getIncomeStatement(filter: PeriodFilter): Promise<IncomeStatementReport> { const raw = await invoke<RawRecord>('get_income_statement', { filter: periodFilterToRaw(filter) }); return { scope: statementScopeFromRaw(raw.scope), currency: reportCurrencyFromRaw(raw.currency), rows: rawArray(raw.rows).map(statementRowFromRaw), sections: numberRecord(raw.sections), previousSections: numberRecord(raw.previous_sections), revenueCents: numberValue(raw.revenue_cents), expenseCents: numberValue(raw.expense_cents), profitCents: numberValue(raw.profit_cents), previousRevenueCents: numberValue(raw.previous_revenue_cents), previousExpenseCents: numberValue(raw.previous_expense_cents), previousProfitCents: numberValue(raw.previous_profit_cents) }; },
  async getReminderSettings(): Promise<ReminderSettings> { const row = await invoke<RawRecord | null>('get_reminder_settings'); return { enabled: boolValue(row?.enabled), senderName: stringValue(row?.sender_name) }; },
  async updateReminderSettings(settings: ReminderSettings) { await invoke('update_reminder_settings', { input: { enabled: settings.enabled, sender_name: settings.senderName || null } }); },
  async listReminderTemplates(): Promise<ReminderTemplate[]> { return rawArray(await invoke<unknown>('list_reminder_templates')).map(reminderTemplateFromRaw); },
  async upsertReminderTemplate(input: Omit<ReminderTemplate, 'id'> & { id?: string }) { await invoke('upsert_reminder_template', { input: { id: input.id || null, level: input.level, name: input.name, subject: input.subject, body: input.body, days_after_due: input.daysAfterDue, active: input.active } }); },
  async deleteReminderTemplate(id: string) { await invoke('delete_reminder_template', { id }); },
  async generateDueReminders(asOf?: string) { return rawArray(await invoke<unknown>('generate_due_reminders', { asOf: asOf || null }), 'reminders').map(reminderFromRaw); },
  async listReminders(filter: { status?: ReminderStatus; invoiceId?: string; dateFrom?: string; dateTo?: string } = {}): Promise<Reminder[]> { return rawArray(await invoke<unknown>('list_reminders', { filter: { status: filter.status || null, invoice_id: filter.invoiceId || null, date_from: filter.dateFrom || null, date_to: filter.dateTo || null } }), 'reminders').map(reminderFromRaw); },
  async getReminderHistory(reminderId: string): Promise<ReminderHistory[]> { return rawArray(await invoke<unknown>('get_reminder_history', { reminderId }), 'history').map((row) => ({ id: stringValue(row.id), reminderId: stringValue(row.reminder_id), action: stringValue(row.action), occurredAt: stringValue(row.occurred_at), note: stringValue(row.note) })); },
  async markReminder(id: string, status: ReminderStatus, note?: string) { await invoke('mark_reminder', { input: { id, status, note: note || null } }); },
  async recordReminderAction(id: string, action: 'printed' | 'exported' | 'sent_manually' | 'note', note?: string) { await invoke('record_reminder_action', { input: { id, action, note: note || null } }); },
  async listPayrollContributionDefinitions(asOf?: string): Promise<PayrollContributionDefinition[]> { return rawArray(await invoke<unknown>('list_payroll_contribution_definitions', { asOf: asOf || null })).map(contributionFromRaw); },
  async getPayrollRegulatoryProfiles(): Promise<PayrollRegulatoryProfile[]> { return rawArray(await invoke<unknown>('get_payroll_regulatory_profiles')).map((row) => ({ id: stringValue(row.id), label: stringValue(row.label), source: stringValue(row.source), effectiveFrom: stringValue(row.effective_from), effectiveTo: stringValue(row.effective_to), definitions: rawArray(row.definitions).map((definition) => { const normalized = contributionFromRaw(definition); return { code: normalized.code, label: normalized.label, category: normalized.category, side: normalized.side, calculationKind: normalized.calculationKind, rateBp: normalized.rateBp, fixedAmountCents: normalized.fixedAmountCents, annualCeilingCents: normalized.annualCeilingCents, basisKind: normalized.basisKind, source: normalized.source, effectiveFrom: normalized.effectiveFrom, effectiveTo: normalized.effectiveTo, active: normalized.active }; }), notIncluded: Array.isArray(row.not_included) ? row.not_included.map(stringValue) as PayrollRegulatoryProfile['notIncluded'] : [] })); },
  async upsertPayrollContributionDefinition(input: Omit<PayrollContributionDefinition, 'id'> & { id?: string }) { await invoke('upsert_payroll_contribution_definition', { input: { id: input.id || null, code: input.code, label: input.label, category: input.category, side: input.side, calculation_kind: input.calculationKind, rate_bp: input.calculationKind === 'rate' ? input.rateBp : null, fixed_amount_cents: input.calculationKind === 'fixed' ? input.fixedAmountCents : null, annual_ceiling_cents: input.annualCeilingCents, basis_kind: input.basisKind, source: input.source, effective_from: input.effectiveFrom, effective_to: input.effectiveTo || null, active: input.active, liability_account_id: input.liabilityAccountId || null, expense_account_id: input.expenseAccountId || null } }); },
  async deletePayrollContributionDefinition(id: string) { await invoke('delete_payroll_contribution_definition', { id }); },
  async calculatePayrollContributions(input: { employeeId: string; period: string; grossCents: number; items: PayrollContributionSelection[] }): Promise<PayrollCalculation> { const raw = await invoke<RawRecord>('calculate_employee_payroll_contributions', { input: { employee_id: input.employeeId, period: input.period, gross_cents: input.grossCents, items: input.items.map((item) => ({ definition_id: item.definitionId, basis_cents: item.basisCents, year_to_date_basis_cents: item.yearToDateBasisCents })) } }); const items = rawArray(raw.items).map((row): CalculatedPayrollContribution => ({ ...contributionFromRaw(row), originalBasisCents: numberValue(row.original_basis_cents), basisCents: numberValue(row.basis_cents), amountCents: numberValue(row.amount_cents), statutoryAnnualCeilingCents: row.statutory_annual_ceiling_cents === null || row.statutory_annual_ceiling_cents === undefined ? null : numberValue(row.statutory_annual_ceiling_cents), acProrationDays: row.ac_proration_days_30_360 === null || row.ac_proration_days_30_360 === undefined ? null : numberValue(row.ac_proration_days_30_360), acEmploymentFrom: stringValue(row.ac_employment_from), acEmploymentTo: stringValue(row.ac_employment_to), avsAllowanceAppliedCents: row.avs_allowance_applied_cents === null || row.avs_allowance_applied_cents === undefined ? null : numberValue(row.avs_allowance_applied_cents), avsAllowanceWaived: row.avs_allowance_waived === null || row.avs_allowance_waived === undefined ? null : boolValue(row.avs_allowance_waived) })); return { period: stringValue(raw.period) || input.period, grossCents: numberValue(raw.gross_cents), employeeDeductionsCents: numberValue(raw.employee_deductions_cents), employerCostsCents: numberValue(raw.employer_costs_cents), items }; },
  async applyPayrollContributions(payslipId: string, period: string, items: PayrollContributionSelection[]) { await invoke('apply_payroll_contributions', { input: { payslip_id: payslipId, period, items: items.map((item) => ({ definition_id: item.definitionId, basis_cents: item.basisCents, year_to_date_basis_cents: item.yearToDateBasisCents })) } }); return loadWorkspace(); },
  async getPayslipContributions(payslipId: string): Promise<PayslipContributionSnapshot[]> { return rawArray(await invoke<unknown>('get_payslip_contributions', { payslipId })).map(payslipContributionFromRaw); },
  async postPayslip(payslipId: string, entryDate?: string): Promise<PostPayslipResult> {
    const posted = await invoke<RawRecord>('post_payslip', { input: { payslip_id: payslipId, entry_date: entryDate || null } });
    return { workspace: await loadWorkspace(), accountingFallbacks: accountingFallbacksFromPostPayslip(posted) };
  },
  async payPayslip(payslipId: string, paymentDate: string, reference?: string) { await invoke('pay_payslip', { input: { payslip_id: payslipId, payment_date: paymentDate || null, reference: reference?.trim() || null } }); return loadWorkspace(); },
  async exportPayslipPdf(payslipId: string, suggestedFileName: string): Promise<{ path: string; pages: number; finalDocument: boolean } | null> {
    const selected = await chooseSaveFile({ title: 'Enregistrer la fiche de salaire PDF', defaultPath: suggestedFileName, filters: [{ name: 'Document PDF', extensions: ['pdf'] }] });
    if (!selected) return null;
    const destinationPath = selected.toLowerCase().endsWith('.pdf') ? selected : `${selected}.pdf`;
    const raw = await invoke<RawRecord>('generate_payslip_pdf', { input: { payslip_id: payslipId, destination_path: destinationPath } });
    return { path: stringValue(raw.path), pages: numberValue(raw.pages), finalDocument: boolValue(raw.final_document) };
  },
  async saveInvoiceQrBill(invoiceId: string, bill: SwissQrBillInput): Promise<StoredSwissQrBill> {
    const raw = await invoke<RawRecord>('save_invoice_qr_bill', { input: { invoice_id: invoiceId, bill: qrInputToRaw(bill) } });
    const stored = storedQrBillFromRaw(raw, invoiceId);
    if (!stored) throw new Error('La QR-facture validée n’a pas pu être relue après son enregistrement local.');
    return stored;
  },
  async getInvoiceQrBill(invoiceId: string): Promise<StoredSwissQrBill | null> {
    const raw = await invoke<RawRecord | null>('get_invoice_qr_bill', { invoiceId });
    return raw ? storedQrBillFromRaw(raw, invoiceId) : null;
  },
  async validateSwissQrBill(input: SwissQrBillInput): Promise<SwissQrValidation> { const raw = await invoke<RawRecord>('validate_swiss_qr_bill', { input: qrInputToRaw(input) }); return { valid: boolValue(raw.valid), errors: Array.isArray(raw.errors) ? raw.errors.map(stringValue) : [], warnings: Array.isArray(raw.warnings) ? raw.warnings.map(stringValue) : [], normalized: qrInputFromRaw(raw.normalized as RawRecord), isQrIban: boolValue(raw.is_qr_iban) }; },
  async generateSwissQrPayload(input: SwissQrBillInput): Promise<SwissQrPayload> { const raw = await invoke<RawRecord>('generate_swiss_qr_payload', { input: qrInputToRaw(input) }); return { payload: stringValue(raw.payload), lines: Array.isArray(raw.lines) ? raw.lines.map(stringValue) : [], referenceType: stringValue(raw.reference_type) as SwissQrBillInput['referenceType'], isQrIban: boolValue(raw.is_qr_iban), characterCount: numberValue(raw.character_count), byteCount: numberValue(raw.byte_count) }; },
  openDataFolder: () => invoke<string>('open_data_folder'),
};
