import { Channel, invoke } from '@tauri-apps/api/core';
import { fileBase64 } from './projectDocuments';
import { refreshWorkspaceAfterMutation } from './workspaceMutation';
import { PayslipPostingRefreshError } from './payrollMutation';
import { isMobileRuntime, materializeMobileFile, shareMobileExport } from './mobileRuntime';
import type {
  OpenDialogOptions,
  SaveDialogOptions,
} from '@tauri-apps/plugin-dialog';
import type {
  Account,
  AgendaEvent,
  AccountingConfigurationResult,
  AccountingContinuity,
  AccountingFallback,
  AccountingPeriod,
  AccountingSettings,
  AppSettings,
  Attachment,
  BalanceSheetReport,
  BackupStatus,
  BankReconciliationResult,
  BankSupplierReconciliationResult,
  BankWorkspace,
  CalculatedPayrollContribution,
  CatalogItem,
  Client,
  CreateRecurrenceScheduleInput,
  DeliveryNote,
  DeliveryNoteLine,
  DocumentLine,
  Employee,
  EmployeePayrollTemplate,
  EntityKind,
  Expense,
  FiduciaryClosingReview,
  FiduciaryPackageExport,
  FiduciaryPeriodFinalization,
  FrozenCustomer,
  FrozenDeliveryNoteSnapshot,
  FrozenDocumentSnapshot,
  FrozenEmployee,
  FrozenIssuer,
  FrozenPayslipSnapshot,
  FrozenSalesOrderRecord,
  FrozenSalesOrderSnapshot,
  GenerateRecurrenceOccurrencesInput,
  Invoice,
  InvoiceCorrectionWorkflow,
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
  PayrollAnalysisManifest,
  PayrollDocumentImport,
  PayrollImportDraft,
  PayrollCalculation,
  PayrollContributionDefinition,
  PayrollContributionSelection,
  PayrollRegulatoryProfile,
  PayrollSmallSalaryCalculationAssessment,
  PeriodFilter,
  PostPayslipResult,
  Project,
  ProjectMilestone,
  ProjectTask,
  Quote,
  RecurrenceFrequency,
  RecurrenceOccurrence,
  RecurrenceSchedule,
  Reminder,
  ReminderActionResult,
  ReminderDeliveryAction,
  ReminderHistory,
  ReminderParty,
  ReminderPreview,
  ReminderScanResult,
  ReminderSender,
  ReminderSettings,
  ReminderStatus,
  ReminderTemplate,
  ReportCurrency,
  SecureUpdateEvent,
  SecureUpdateMetadata,
  SecureUpdaterPolicy,
  SalesOrder,
  SalesOrderFulfillmentMode,
  SalesOrderInvoiceAllocation,
  SalesOrderInvoiceBatch,
  SalesOrderInvoicePreview,
  SalesOrderLine,
  StatementRow,
  StatementScope,
  StockMovement,
  StockMovementType,
  StockAvailability,
  StockReservationEvent,
  StoredSwissQrBill,
  Supplier,
  SupplierCreditAllocation,
  SupplierCreditNote,
  SupplierCreditNoteItem,
  SupplierExpenseReclassification,
  SupplierExpenseReclassificationLine,
  SupplierInvoice,
  SupplierInvoiceItem,
  SupplierInvoiceMatch,
  SaveSupplierInvoiceMatchDraftInput,
  SupplierInvoicePayment,
  SupplierOrder,
  SupplierOrderCancellationLine,
  SupplierOrderFulfillmentMode,
  SupplierOrderLine,
  SupplierReceipt,
  SupplierReceiptLine,
  SwissQrBillInput,
  SwissQrPayload,
  SwissQrValidation,
  TimeEntry,
  TimeBillingBatch,
  TimeBillingEntry,
  TrialBalanceReport,
  TrialBalanceRow,
  UpdateRecurrenceScheduleInput,
  VatAdjustment,
  VatAdjustmentCategory,
  VatProfile,
  VatReportingBasis,
  VatReportingMethod,
  VatReportingPeriodicity,
  VatReturnExport,
  VatReturnPreview,
  VatSourceClassification,
  VatSourceTreatment,
  VatSourceType,
  VatSubmissionType,
  Workspace,
} from './types';
import type { SupplierEmailInspection } from './supplierEmail';
import type { ManualJournalSubmission } from './accountingManualJournal';
import type { OnboardingValidationScope } from './onboardingValidation';
import type { CatalogImportRow } from './catalogImport';
import { validDepositPercentageBp } from './deposit';
import {
  bankAccountAssociationPayload,
  bankConfirmationPayload,
  bankReconciliationResultFromRaw,
  bankSupplierReconciliationResultFromRaw,
  bankWorkspaceFromRaw,
  camtImportResultFromRaw,
  supplierBankConfirmationPayload,
} from './bank';
import { expensePaymentStatusFromRaw } from './purchases';
import {
  pdfDestinationPath,
  salesPdfInvokeInput,
  type SalesPdfEntity,
} from './salesPdfExport';

type RawRecord = Record<string, unknown>;
type AppState = {
  onboarding_completed: boolean;
  activity_profile_required?: boolean;
  data_dir: string;
  database_path: string;
  app_version: string;
};
type SupplierInvoiceDraftSaveInput = {
  id: string;
  supplierId: string;
  projectId?: string | null;
  date: string;
  dueDate: string;
  reference?: string;
  note?: string;
  items: Array<{
    id?: string;
    description: string;
    quantityMilli: number;
    unit?: string;
    unitPriceCents: number;
    discountBp?: number;
    vatBp: number;
    category: string;
    expenseAccountId?: string | null;
    projectId?: string | null;
  }>;
};
export type OnboardingValidationIssue = {
  step: number;
  field: string;
  label: string;
  message: string;
};
export type OnboardingValidationResult = {
  valid: boolean;
  issues: OnboardingValidationIssue[];
};
export type CloudAccountState = {
  status: 'disconnected' | 'pending' | 'connected' | 'expired' | 'inactive';
  organizationId?: string;
  organizationName?: string;
  role?: 'owner' | 'admin' | 'accountant' | 'member' | 'read_only';
  sessionExpiresAt?: string;
  userCode?: string;
  verificationUri?: string;
  authorizationExpiresAt?: string;
  intervalSeconds?: number;
};
export type InvoiceArchiveResult = {
  archiveId: string;
  revision: number;
  contentSha256: string;
  retentionUntil: string;
  alreadyStored: boolean;
};
type RawWorkspace = {
  schema_version?: unknown;
  settings?: RawRecord | null;
  clients?: RawRecord[];
  catalog_items?: RawRecord[];
  stock_movements?: RawRecord[];
  suppliers?: RawRecord[];
  projects?: RawRecord[];
  project_milestones?: RawRecord[];
  project_tasks?: RawRecord[];
  agenda_events?: RawRecord[];
  quotes?: RawRecord[];
  quote_items?: RawRecord[];
  sales_orders?: RawRecord[];
  sales_order_lines?: RawRecord[];
  recurrence_schedules?: RawRecord[];
  recurrence_occurrences?: RawRecord[];
  delivery_notes?: RawRecord[];
  delivery_note_lines?: RawRecord[];
  stock_reservation_events?: RawRecord[];
  stock_availability?: RawRecord[];
  sales_order_invoice_batches?: RawRecord[];
  sales_order_invoice_allocations?: RawRecord[];
  invoices?: RawRecord[];
  invoice_correction_workflows?: RawRecord[];
  invoice_items?: RawRecord[];
  invoice_qr_bills?: RawRecord[];
  employees?: RawRecord[];
  time_entries?: RawRecord[];
  time_billing_batches?: RawRecord[];
  time_billing_entries?: RawRecord[];
  expenses?: RawRecord[];
  supplier_orders?: RawRecord[];
  supplier_order_lines?: RawRecord[];
  supplier_order_cancellation_lines?: RawRecord[];
  supplier_receipts?: RawRecord[];
  supplier_receipt_lines?: RawRecord[];
  supplier_invoices?: RawRecord[];
  supplier_invoice_items?: RawRecord[];
  supplier_invoice_matches?: RawRecord[];
  supplier_credit_notes?: RawRecord[];
  supplier_credit_note_items?: RawRecord[];
  supplier_credit_allocations?: RawRecord[];
  supplier_expense_reclassifications?: RawRecord[];
  supplier_expense_reclassification_lines?: RawRecord[];
  supplier_payments?: RawRecord[];
  accounts?: RawRecord[];
  attachments?: RawRecord[];
  payslips?: RawRecord[];
  payslip_items?: RawRecord[];
  payroll_document_imports?: RawRecord[];
  employee_payroll_templates?: RawRecord[];
  payments?: RawRecord[];
  active_timer?: RawRecord | null;
  accounting_settings?: RawRecord | null;
  backup_status?: RawRecord | null;
};

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const numberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const boolValue = (value: unknown): boolean =>
  value === true || value === 1 || value === '1';
const recordValue = (value: unknown): RawRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : {};

function cloudAccountStateFromRaw(raw: RawRecord): CloudAccountState {
  const status = stringValue(raw.status);
  if (
    !['disconnected', 'pending', 'connected', 'expired', 'inactive'].includes(
      status,
    )
  ) {
    throw new Error('État du compte Zentra invalide.');
  }
  const role = stringValue(raw.role);
  return {
    status: status as CloudAccountState['status'],
    organizationId: stringValue(raw.organizationId) || undefined,
    organizationName: stringValue(raw.organizationName) || undefined,
    role: ['owner', 'admin', 'accountant', 'member', 'read_only'].includes(role)
      ? (role as CloudAccountState['role'])
      : undefined,
    sessionExpiresAt: stringValue(raw.sessionExpiresAt) || undefined,
    userCode: stringValue(raw.userCode) || undefined,
    verificationUri: stringValue(raw.verificationUri) || undefined,
    authorizationExpiresAt:
      stringValue(raw.authorizationExpiresAt) || undefined,
    intervalSeconds:
      raw.intervalSeconds === null || raw.intervalSeconds === undefined
        ? undefined
        : numberValue(raw.intervalSeconds),
  };
}

export function employeeSmallSalaryFieldsFromRaw(
  row: RawRecord,
): Pick<
  Employee,
  | 'smallSalaryAssessmentYear'
  | 'smallSalarySector'
  | 'smallSalaryEmployeeRequestedContributions'
  | 'smallSalaryDecisionDate'
  | 'smallSalaryOpeningGrossCents'
  | 'smallSalaryOpeningContributedBasisCents'
  | 'smallSalaryEvidenceReference'
> {
  const invalid = (field: string, detail: string): never => {
    throw new Error(
      `Contrat collaborateur des petits salaires invalide (${field}) : ${detail}`,
    );
  };
  const fields = {
    assessmentYear: row.small_salary_assessment_year,
    sector: row.small_salary_sector,
    employeeRequestedContributions:
      row.small_salary_employee_requested_contributions,
    decisionDate: row.small_salary_decision_date,
    openingGrossCents: row.small_salary_opening_gross_cents,
    openingContributedBasisCents:
      row.small_salary_opening_contributed_basis_cents,
    evidenceReference: row.small_salary_evidence_reference,
  };
  const isAbsent = (value: unknown) =>
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '');
  const presentCount = Object.values(fields).filter(
    (value) => !isAbsent(value),
  ).length;
  if (presentCount === 0) {
    return {
      smallSalaryAssessmentYear: null,
      smallSalarySector: null,
      smallSalaryEmployeeRequestedContributions: null,
      smallSalaryDecisionDate: '',
      smallSalaryOpeningGrossCents: null,
      smallSalaryOpeningContributedBasisCents: null,
      smallSalaryEvidenceReference: '',
    };
  }
  if (presentCount !== Object.keys(fields).length)
    return invalid(
      'small_salary_*',
      'les sept champs doivent être présents ensemble ou tous absents.',
    );

  const integer = (
    field: string,
    value: unknown,
    options: { min: number; max?: number },
  ) => {
    if (!Number.isSafeInteger(value))
      return invalid(field, 'un entier sûr est obligatoire.');
    const parsed = value as number;
    if (parsed < options.min)
      invalid(field, `la valeur doit être au moins ${options.min}.`);
    if (options.max !== undefined && parsed > options.max)
      invalid(field, `la valeur doit être au plus ${options.max}.`);
    return parsed;
  };
  const assessmentYear = integer(
    'small_salary_assessment_year',
    fields.assessmentYear,
    { min: 1900, max: 9999 },
  );
  const sector = fields.sector;
  if (
    sector !== 'ordinary' &&
    sector !== 'private_household' &&
    sector !== 'arts_culture'
  )
    return invalid(
      'small_salary_sector',
      'ordinary, private_household ou arts_culture était attendu.',
    );
  const requested = fields.employeeRequestedContributions;
  if (typeof requested !== 'boolean' && requested !== 0 && requested !== 1)
    return invalid(
      'small_salary_employee_requested_contributions',
      'un booléen explicite ou son entier SQLite 0/1 est obligatoire.',
    );
  if (typeof fields.decisionDate !== 'string')
    return invalid(
      'small_salary_decision_date',
      'une date texte AAAA-MM-JJ est obligatoire.',
    );
  const decisionDate = fields.decisionDate.trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(decisionDate);
  if (!dateMatch)
    return invalid(
      'small_salary_decision_date',
      'une date réelle AAAA-MM-JJ est obligatoire.',
    );
  const decisionYear = Number(dateMatch[1]);
  const decisionMonth = Number(dateMatch[2]);
  const decisionDay = Number(dateMatch[3]);
  const parsedDate = new Date(
    Date.UTC(decisionYear, decisionMonth - 1, decisionDay),
  );
  if (
    parsedDate.getUTCFullYear() !== decisionYear ||
    parsedDate.getUTCMonth() !== decisionMonth - 1 ||
    parsedDate.getUTCDate() !== decisionDay ||
    decisionYear !== assessmentYear
  )
    invalid(
      'small_salary_decision_date',
      'la date doit être réelle et appartenir à l’année d’évaluation.',
    );
  const openingGrossCents = integer(
    'small_salary_opening_gross_cents',
    fields.openingGrossCents,
    { min: 0 },
  );
  const openingContributedBasisCents = integer(
    'small_salary_opening_contributed_basis_cents',
    fields.openingContributedBasisCents,
    { min: 0 },
  );
  if (openingContributedBasisCents > openingGrossCents)
    invalid(
      'small_salary_opening_contributed_basis_cents',
      'la base déjà cotisée dépasse le brut d’ouverture.',
    );
  if (typeof fields.evidenceReference !== 'string')
    return invalid(
      'small_salary_evidence_reference',
      'un texte non vide est obligatoire.',
    );
  const evidenceReference = fields.evidenceReference.trim();
  if (!evidenceReference || evidenceReference.length > 500)
    return invalid(
      'small_salary_evidence_reference',
      'un texte de 1 à 500 caractères est obligatoire.',
    );

  return {
    smallSalaryAssessmentYear: assessmentYear,
    smallSalarySector: sector,
    smallSalaryEmployeeRequestedContributions:
      requested === true || requested === 1,
    smallSalaryDecisionDate: decisionDate,
    smallSalaryOpeningGrossCents: openingGrossCents,
    smallSalaryOpeningContributedBasisCents: openingContributedBasisCents,
    smallSalaryEvidenceReference: evidenceReference,
  };
}

export function backupStatusFromRaw(value: unknown): BackupStatus {
  const row = recordValue(value);
  return {
    lastSuccessAt:
      stringValue(row.last_success_at ?? row.lastSuccessAt) || null,
    lastPath: stringValue(row.last_path ?? row.lastPath) || null,
    nextScheduledAt:
      stringValue(row.next_scheduled_at ?? row.nextScheduledAt) || null,
  };
}

/**
 * Les sauvegardes conservent les logos hashés mais une restauration sur un autre
 * compte Windows change APPLOCALDATA. Le snapshot métier reste immuable : seul
 * son pointeur de lecture est rebasé vers le dossier local courant.
 */
export function rebaseStoredBrandingPath(
  value: unknown,
  dataDir: string,
): string {
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
    onboarding_completed: boolValue(
      row.onboarding_completed ?? row.onboardingCompleted,
    ),
    activity_profile_required: boolValue(
      row.activity_profile_required ?? row.activityProfileRequired,
    ),
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
    channel: row.channel === 'store' ? 'store' : 'stable',
    endpointHost: stringValue(row.endpointHost ?? row.endpoint_host) || null,
    signatureRequired: true,
    transport: row.channel === 'store' ? 'store' : 'HTTPS',
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
  if (event === 'preparing' || event === 'verifying' || event === 'installed')
    return { event };
  if (event === 'started') {
    return {
      event,
      data: {
        contentLength:
          data.contentLength === null || data.content_length === null
            ? null
            : numberValue(data.contentLength ?? data.content_length) || null,
      },
    };
  }
  if (event === 'progress') {
    return {
      event,
      data: {
        downloadedBytes: numberValue(
          data.downloadedBytes ?? data.downloaded_bytes,
        ),
        contentLength:
          data.contentLength === null || data.content_length === null
            ? null
            : numberValue(data.contentLength ?? data.content_length) || null,
        percent:
          data.percent === null || data.percent === undefined
            ? null
            : Math.max(0, Math.min(100, numberValue(data.percent))),
      },
    };
  }
  return null;
}

function onboardingValidationFromRaw(
  value: unknown,
): OnboardingValidationResult {
  const row = recordValue(value);
  const issues = (Array.isArray(row.issues) ? row.issues : []).map(
    (value): OnboardingValidationIssue => {
      const issue = recordValue(value);
      return {
        step: Math.max(0, Math.trunc(numberValue(issue.step))),
        field: stringValue(issue.field).trim(),
        label: stringValue(issue.label).trim(),
        message: stringValue(issue.message).trim(),
      };
    },
  );
  return { valid: boolValue(row.valid) && issues.length === 0, issues };
}

function parsedSnapshot(value: unknown): RawRecord | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as RawRecord)
      : null;
  } catch {
    return null;
  }
}

function payslipLineKindFromRaw(value: unknown): PayslipLine['kind'] {
  const kind = stringValue(value);
  if (kind === 'non_gross_payment' || kind === 'expense_reimbursement')
    return 'reimbursement';
  return (
    ['earning', 'deduction', 'reimbursement', 'employer'].includes(kind)
      ? kind
      : 'earning'
  ) as PayslipLine['kind'];
}

function payrollImportDraftFromRaw(value: unknown): PayrollImportDraft {
  const root =
    typeof value === 'string'
      ? (parsedSnapshot(value) ?? {})
      : recordValue(value);
  const employee = recordValue(root.employee);
  const lines = Array.isArray(root.lines) ? root.lines.map(recordValue) : [];
  const review = recordValue(root.review);
  const evidence = recordValue(
    review.ai_identity_evidence ?? review.aiIdentityEvidence,
  );
  const evidenceConflicts = Array.isArray(evidence.conflicts)
    ? evidence.conflicts.map(stringValue).filter(Boolean)
    : [];
  const employeeLinkSource = stringValue(
    review.employee_link_source ?? review.employeeLinkSource,
  );
  const reviewStrings = (snakeName: string, camelName: string) => {
    const value = review[snakeName] ?? review[camelName];
    return Array.isArray(value)
      ? [
          ...new Set(
            value
              .map(stringValue)
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ]
      : [];
  };
  const reviewState = Object.keys(review).length
    ? {
        aiIdentityEvidence: Object.keys(evidence).length
          ? {
              passes: Math.max(0, Math.trunc(numberValue(evidence.passes))),
              employeeNumber: stringValue(
                evidence.employee_number ?? evidence.employeeNumber,
              ),
              avsNumber: stringValue(evidence.avs_number ?? evidence.avsNumber),
              birthDate: stringValue(evidence.birth_date ?? evidence.birthDate),
              iban: stringValue(evidence.iban),
              conflicts: evidenceConflicts,
            }
          : undefined,
        employeeId: stringValue(review.employee_id ?? review.employeeId),
        employeeLinkSource: (employeeLinkSource === 'auto' ||
        employeeLinkSource === 'manual'
          ? employeeLinkSource
          : '') as 'auto' | 'manual' | '',
        aiFields: reviewStrings('ai_fields', 'aiFields'),
        aiLineKeys: reviewStrings('ai_line_keys', 'aiLineKeys'),
        aiWarnings: reviewStrings('ai_warnings', 'aiWarnings'),
        manualFields: reviewStrings('manual_fields', 'manualFields'),
        manualLineKeys: reviewStrings('manual_line_keys', 'manualLineKeys'),
        suppressedLineKeys: reviewStrings(
          'suppressed_line_keys',
          'suppressedLineKeys',
        ),
        confirmedRecurringLines: (Array.isArray(
          review.confirmed_recurring_lines ?? review.confirmedRecurringLines,
        )
          ? ((review.confirmed_recurring_lines ??
              review.confirmedRecurringLines) as unknown[])
          : []
        )
          .map(recordValue)
          .flatMap((line) => {
            const label = stringValue(line.label).trim();
            const amountCents = Math.trunc(
              numberValue(line.amount_cents ?? line.amountCents),
            );
            return label &&
              stringValue(line.kind) === 'earning' &&
              amountCents > 0
              ? [
                  {
                    lineId:
                      stringValue(line.line_id ?? line.lineId) || undefined,
                    label,
                    kind: 'earning' as const,
                    amountCents,
                  },
                ]
              : [];
          }),
      }
    : undefined;
  return {
    employee: {
      employeeNumber: stringValue(
        employee.employee_number ?? employee.employeeNumber,
      ),
      name: stringValue(employee.name),
      role: stringValue(employee.role),
      addressLine1: stringValue(
        employee.address_line1 ?? employee.addressLine1,
      ),
      addressLine2: stringValue(
        employee.address_line2 ?? employee.addressLine2,
      ),
      postalCode: stringValue(employee.postal_code ?? employee.postalCode),
      city: stringValue(employee.city),
      canton: stringValue(employee.canton),
      birthDate: stringValue(employee.birth_date ?? employee.birthDate),
      avsNumber: stringValue(employee.avs_number ?? employee.avsNumber),
      iban: stringValue(employee.iban),
      employmentRate:
        numberValue(employee.employment_rate ?? employee.employmentRate) || 100,
      salaryMode:
        stringValue(employee.salary_mode ?? employee.salaryMode) === 'hourly'
          ? 'hourly'
          : 'monthly',
    },
    period: stringValue(root.period),
    paymentDate: stringValue(root.payment_date ?? root.paymentDate),
    grossCents: numberValue(root.gross_cents ?? root.grossCents),
    netCents: numberValue(root.net_cents ?? root.netCents),
    lines: lines.map((line, index) => ({
      id: stringValue(line.id) || `import-line-${index}`,
      sourceRef: stringValue(line.source_ref ?? line.sourceRef) || undefined,
      label: stringValue(line.label),
      kind: payslipLineKindFromRaw(line.kind),
      amountCents: numberValue(line.amount_cents ?? line.amountCents),
      recurring: boolValue(line.recurring),
      confidenceBp: numberValue(line.confidence_bp ?? line.confidenceBp),
    })),
    warnings: Array.isArray(root.warnings)
      ? root.warnings.map(stringValue).filter(Boolean)
      : [],
    review: reviewState,
  };
}

function strictIntegerList(
  value: unknown,
  minimum: number,
  maximum: number,
  allowEmpty = false,
): number[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
    return undefined;
  if (
    value.some(
      (item) =>
        typeof item !== 'number' ||
        !Number.isSafeInteger(item) ||
        item < minimum ||
        item > maximum,
    )
  ) {
    return undefined;
  }
  const numbers = value as number[];
  if (new Set(numbers).size !== numbers.length) return undefined;
  return [...numbers].sort((left, right) => left - right);
}

const validManifestText = (value: unknown, maximum: number): string | null => {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    return null;
  return value;
};

const validManifestTarget = (value: unknown): string | null => {
  const target = validManifestText(value, 160);
  return target && /^[A-Za-z0-9._\[\]-]+$/.test(target) ? target : null;
};

const payrollManifestFieldTargets = new Set([
  'employee.name',
  'employee.employee_number',
  'employee.role',
  'employee.address',
  'employee.birth_date',
  'employee.avs_number',
  'employee.iban',
  'employee.employment_rate',
  'employee.salary_mode',
  'period',
  'payment_date',
  'gross_cents',
  'net_cents',
]);

export function payrollAnalysisManifestFromRaw(
  value: unknown,
  mediaKind?: 'pdf' | 'image',
): PayrollAnalysisManifest | undefined {
  const root =
    typeof value === 'string'
      ? (parsedSnapshot(value) ?? {})
      : recordValue(value);
  if (!Object.keys(root).length) return undefined;
  const schemaVersion = root.schema_version ?? root.schemaVersion;
  const corroborationMethod =
    root.corroboration_method ?? root.corroborationMethod;
  const corroborationAlgorithmVersion =
    root.corroboration_algorithm_version ?? root.corroborationAlgorithmVersion;
  const modelId = validManifestText(root.model_id ?? root.modelId, 200);
  const modelRevision = validManifestText(
    root.model_revision ?? root.modelRevision,
    200,
  );
  const inputSha256 = validManifestText(
    root.input_sha256 ?? root.inputSha256,
    64,
  );
  const analyzedPages = strictIntegerList(
    root.analyzed_pages ?? root.analyzedPages,
    1,
    12,
  );
  const passes = root.passes;
  const analyzedAt = validManifestText(root.analyzed_at ?? root.analyzedAt, 64);
  const timestampPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    !modelId ||
    !modelRevision ||
    !inputSha256 ||
    !/^[0-9a-f]{64}$/.test(inputSha256) ||
    !analyzedPages ||
    typeof passes !== 'number' ||
    !Number.isSafeInteger(passes) ||
    passes < 1 ||
    passes > 4 ||
    !analyzedAt ||
    !timestampPattern.test(analyzedAt) ||
    Number.isNaN(Date.parse(analyzedAt))
  ) {
    return undefined;
  }
  if (
    schemaVersion === 2 &&
    (!['local_visual_read', 'local_visual_read_with_pdf_text'].includes(
      String(corroborationMethod),
    ) ||
      corroborationAlgorithmVersion !==
        'zentra.payroll-evidence-corroboration.v1')
  ) {
    return undefined;
  }
  if (
    schemaVersion === 2 &&
    mediaKind === 'image' &&
    corroborationMethod === 'local_visual_read_with_pdf_text'
  ) {
    return undefined;
  }
  const validConfidence = (confidenceBp: unknown): confidenceBp is number => {
    if (
      typeof confidenceBp !== 'number' ||
      !Number.isSafeInteger(confidenceBp) ||
      confidenceBp < 0 ||
      confidenceBp > 10_000
    )
      return false;
    if (schemaVersion === 1) return true;
    const visual = passes >= 2 ? 7_000 : 5_200;
    const textCorroborated = passes >= 2 ? 9_200 : 7_800;
    return (
      confidenceBp === visual ||
      (corroborationMethod === 'local_visual_read_with_pdf_text' &&
        confidenceBp === textCorroborated)
    );
  };
  const analyzedPageSet = new Set(analyzedPages);

  const fieldProvenance: PayrollAnalysisManifest['fieldProvenance'] = [];
  const rawFieldProvenance = root.field_provenance ?? root.fieldProvenance;
  if (!Array.isArray(rawFieldProvenance) || rawFieldProvenance.length > 256)
    return undefined;
  const fieldTargets = new Set<string>();
  for (const value of rawFieldProvenance) {
    const row = recordValue(value);
    // V1 historique ne liait pas la page à une valeur. Conserver le reste du
    // manifeste, mais ne jamais restaurer cette ancienne indication ambiguë.
    // En v2, la valeur fait partie du contrat de preuve : son absence rend le
    // manifeste incomplet et doit donc échouer sans réparation silencieuse.
    if (row.value === undefined) {
      if (schemaVersion === 1) continue;
      return undefined;
    }
    const field = validManifestTarget(row.field);
    const fieldValue = validManifestText(row.value, 500);
    const pages = strictIntegerList(row.pages, 1, 12);
    const passIndexes = strictIntegerList(
      row.pass_indexes ?? row.passIndexes,
      1,
      passes,
    );
    const confidenceBp = row.confidence_bp ?? row.confidenceBp;
    if (
      !field ||
      !payrollManifestFieldTargets.has(field) ||
      !fieldValue ||
      fieldTargets.has(field) ||
      !pages ||
      pages.some((page) => !analyzedPageSet.has(page)) ||
      !passIndexes ||
      !validConfidence(confidenceBp)
    ) {
      return undefined;
    }
    fieldTargets.add(field);
    fieldProvenance.push({
      field,
      value: fieldValue,
      pages,
      passIndexes,
      confidenceBp,
    });
  }

  const lineProvenance: PayrollAnalysisManifest['lineProvenance'] = [];
  const rawLineProvenance = root.line_provenance ?? root.lineProvenance;
  if (!Array.isArray(rawLineProvenance) || rawLineProvenance.length > 512)
    return undefined;
  const lineIndexes = new Set<number>();
  for (const value of rawLineProvenance) {
    const row = recordValue(value);
    const lineIndex = row.line_index ?? row.lineIndex;
    const label = validManifestText(row.label, 200);
    const rawKind = row.kind;
    const amountCents = row.amount_cents ?? row.amountCents;
    const pages = strictIntegerList(row.pages, 1, 12);
    const passIndexes = strictIntegerList(
      row.pass_indexes ?? row.passIndexes,
      1,
      passes,
    );
    const confidenceBp = row.confidence_bp ?? row.confidenceBp;
    if (
      typeof lineIndex !== 'number' ||
      !Number.isSafeInteger(lineIndex) ||
      lineIndex < 0 ||
      lineIndexes.has(lineIndex) ||
      !label ||
      typeof rawKind !== 'string' ||
      !['earning', 'deduction', 'reimbursement', 'employer'].includes(
        rawKind,
      ) ||
      typeof amountCents !== 'number' ||
      !Number.isSafeInteger(amountCents) ||
      amountCents < 0 ||
      !pages ||
      pages.some((page) => !analyzedPageSet.has(page)) ||
      !passIndexes ||
      !validConfidence(confidenceBp)
    ) {
      return undefined;
    }
    lineIndexes.add(lineIndex);
    lineProvenance.push({
      lineIndex,
      label,
      kind: rawKind as PayslipLine['kind'],
      amountCents,
      pages,
      passIndexes,
      confidenceBp,
    });
  }

  const conflicts: PayrollAnalysisManifest['conflicts'] = [];
  if (!Array.isArray(root.conflicts) || root.conflicts.length > 128)
    return undefined;
  const conflictTargets = new Set<string>();
  for (const value of root.conflicts) {
    const row = recordValue(value);
    const target = validManifestTarget(row.target);
    const values = Array.isArray(row.values)
      ? row.values.map((item) => validManifestText(item, 250))
      : [];
    const pages = strictIntegerList(row.pages, 1, 12);
    const passIndexes = strictIntegerList(
      row.pass_indexes ?? row.passIndexes,
      1,
      passes,
    );
    if (
      !target ||
      !payrollManifestFieldTargets.has(target) ||
      fieldTargets.has(target) ||
      conflictTargets.has(target) ||
      values.length < 2 ||
      values.length > 8 ||
      values.some((item) => !item) ||
      new Set(values).size !== values.length ||
      !pages ||
      pages.some((page) => !analyzedPageSet.has(page)) ||
      !passIndexes
    ) {
      return undefined;
    }
    conflictTargets.add(target);
    conflicts.push({
      target,
      values: values as string[],
      pages,
      passIndexes,
    });
  }

  const common = {
    modelId,
    modelRevision,
    inputSha256,
    analyzedPages,
    passes,
    fieldProvenance,
    lineProvenance,
    conflicts,
    analyzedAt,
  };
  return schemaVersion === 2
    ? {
        ...common,
        schemaVersion: 2,
        corroborationMethod: corroborationMethod as
          | 'local_visual_read'
          | 'local_visual_read_with_pdf_text',
        corroborationAlgorithmVersion:
          'zentra.payroll-evidence-corroboration.v1',
      }
    : { ...common, schemaVersion: 1 };
}

export function payrollAnalysisManifestToRaw(
  manifest: PayrollAnalysisManifest,
): RawRecord {
  return {
    schema_version: manifest.schemaVersion,
    ...(manifest.schemaVersion === 2
      ? {
          corroboration_method: manifest.corroborationMethod,
          corroboration_algorithm_version:
            manifest.corroborationAlgorithmVersion,
        }
      : {}),
    model_id: manifest.modelId,
    model_revision: manifest.modelRevision,
    input_sha256: manifest.inputSha256,
    analyzed_pages: manifest.analyzedPages,
    passes: manifest.passes,
    field_provenance: manifest.fieldProvenance.map((provenance) => ({
      field: provenance.field,
      value: provenance.value,
      pages: provenance.pages,
      pass_indexes: provenance.passIndexes,
      confidence_bp: provenance.confidenceBp,
    })),
    line_provenance: manifest.lineProvenance.map((provenance) => ({
      line_index: provenance.lineIndex,
      label: provenance.label,
      kind: provenance.kind,
      amount_cents: provenance.amountCents,
      pages: provenance.pages,
      pass_indexes: provenance.passIndexes,
      confidence_bp: provenance.confidenceBp,
    })),
    conflicts: manifest.conflicts.map((conflict) => ({
      target: conflict.target,
      values: conflict.values,
      pages: conflict.pages,
      pass_indexes: conflict.passIndexes,
    })),
    analyzed_at: manifest.analyzedAt,
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
    pageCount: Math.max(0, Math.trunc(numberValue(row.page_count))),
    extractionEngine: stringValue(row.extraction_engine),
    engineVersion: stringValue(row.engine_version),
    extractedText: stringValue(row.extracted_text),
    draft: payrollImportDraftFromRaw(row.draft_json),
    analysisManifest:
      payrollAnalysisManifestFromRaw(
        row.analysis_manifest_json ?? row.analysisManifest,
        stringValue(row.media_kind) === 'image' ? 'image' : 'pdf',
      ) ?? null,
    confidenceBp: numberValue(row.confidence_bp),
    status: (['needs_review', 'confirmed', 'rejected', 'error'].includes(
      stringValue(row.status),
    )
      ? stringValue(row.status)
      : 'needs_review') as PayrollDocumentImport['status'],
    errorMessage: stringValue(row.error_message),
    employeeId: stringValue(row.employee_id),
    payslipId: stringValue(row.payslip_id),
    reviewedAt: stringValue(row.reviewed_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function employeePayrollTemplateFromRaw(
  row: RawRecord,
): EmployeePayrollTemplate {
  const recurring = (() => {
    try {
      return typeof row.recurring_earnings_json === 'string'
        ? (JSON.parse(row.recurring_earnings_json) as unknown)
        : [];
    } catch {
      return [];
    }
  })();
  const codes = (() => {
    try {
      return typeof row.suggested_contribution_codes_json === 'string'
        ? (JSON.parse(row.suggested_contribution_codes_json) as unknown)
        : [];
    } catch {
      return [];
    }
  })();
  return {
    employeeId: stringValue(row.employee_id),
    salaryMode:
      stringValue(row.salary_mode) === 'hourly' ? 'hourly' : 'monthly',
    baseSalaryCents: numberValue(row.base_salary_cents),
    recurringEarnings: Array.isArray(recurring)
      ? recurring
          .map(recordValue)
          .map((line) => ({
            label: stringValue(line.label),
            kind: 'earning' as const,
            amountCents: numberValue(line.amount_cents ?? line.amountCents),
          }))
          .filter((line) => line.label && line.amountCents > 0)
      : [],
    suggestedContributionCodes: Array.isArray(codes)
      ? codes.map(stringValue).filter(Boolean)
      : [],
    sourceImportId: stringValue(row.source_import_id),
    reviewedAt: stringValue(row.reviewed_at),
  };
}

function licenseStateFromRaw(row: RawRecord): LicenseState {
  return {
    enforcementConfigured: boolValue(row.enforcement_configured),
    status: stringValue(row.status) as LicenseState['status'],
    readOnly: boolValue(row.read_only),
    canRefresh: boolValue(row.can_refresh),
    plan: stringValue(row.plan),
    priceChfCents: numberValue(row.price_chf_cents),
    licenseId: stringValue(row.license_id),
    customerName: stringValue(row.customer_name),
    accessRole: (stringValue(row.access_role) ||
      'owner') as LicenseState['accessRole'],
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
    return parsed && typeof parsed === 'object'
      ? (parsed as Partial<AppSettings>)
      : {};
  } catch {
    return {};
  }
}

function settingsFromRaw(
  row: RawRecord | null | undefined,
  dataDir = '',
): AppSettings | null {
  if (!row || !stringValue(row.company_name)) return null;
  const extra = parseExtra(row);
  const extraBilling = extra.billing;
  const deferred = extra.setupDeferred;
  const configuredVat =
    extraBilling?.vatRatesBp?.filter((rate) => Number.isFinite(rate)) ?? [];
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
        street: [stringValue(row.address_line1), stringValue(row.address_line2)]
          .filter(Boolean)
          .join('\n'),
        buildingNumber: extra.organization?.address?.buildingNumber ?? '',
        postalCode: stringValue(row.postal_code),
        city: stringValue(row.city),
        canton: stringValue(row.canton),
        country: stringValue(row.country),
      },
      logoPath: rebaseStoredBrandingPath(row.logo_path, dataDir) || undefined,
    },
    business: {
      nogaSection: (/^[A-V]$/.test(stringValue(row.noga_section))
        ? stringValue(row.noga_section)
        : '') as AppSettings['business']['nogaSection'],
      nogaDivision: stringValue(row.noga_division),
      activityDescription: stringValue(row.activity_description),
      nogaDetailedCode: stringValue(row.noga_detailed_code),
    },
    billing: {
      currency: 'CHF',
      iban: stringValue(row.iban),
      accountHolder:
        extraBilling?.accountHolder ?? stringValue(row.company_name),
      quotePrefix: stringValue(row.quote_prefix),
      invoicePrefix: stringValue(row.invoice_prefix),
      creditNotePrefix:
        stringValue(row.credit_note_prefix) ||
        extraBilling?.creditNotePrefix ||
        '',
      nextQuoteNumber:
        numberValue(row.quote_start_number) ||
        extraBilling?.nextQuoteNumber ||
        1,
      nextInvoiceNumber:
        numberValue(row.invoice_start_number) ||
        extraBilling?.nextInvoiceNumber ||
        1,
      nextCreditNoteNumber:
        numberValue(row.credit_note_start_number) ||
        extraBilling?.nextCreditNoteNumber ||
        1,
      paymentTermsDays: numberValue(row.payment_terms_days),
      quoteValidityDays:
        extraBilling?.quoteValidityDays ?? numberValue(row.quote_validity_days),
      vatRatesBp: configuredVat.length
        ? configuredVat
        : defaultVat
          ? [defaultVat]
          : [],
      defaultFooter: extraBilling?.defaultFooter ?? '',
      footerTemplates: Array.isArray(extraBilling?.footerTemplates)
        ? extraBilling.footerTemplates
            .filter(
              (template) =>
                template &&
                typeof template.id === 'string' &&
                typeof template.name === 'string' &&
                typeof template.text === 'string',
            )
            .map((template) => ({
              id: template.id.trim(),
              name: template.name.trim(),
              text: template.text,
            }))
            .filter((template) => template.id && template.name && template.text.trim())
        : [],
    },
    work: extra.work ?? {
      workWeekHours: 0,
      dailyHours: 0,
      roundingMinutes: 0,
      breakMinutes: 0,
      costCategories: [],
    },
    payroll: {
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
      ...extra.payroll,
      aanpEmployerCoverage: {
        enabled: false,
        reference: '',
        effectiveFrom: '',
        effectiveTo: '',
        ...extra.payroll?.aanpEmployerCoverage,
      },
    },
    backup: extra.backup ?? {
      automatic: false,
      folder: '',
      frequency: 'manual',
      retentionDaily: 0,
      retentionWeekly: 0,
      retentionMonthly: 0,
      recoveryConfirmed: false,
    },
    setupDeferred: {
      billing: deferred?.billing === true,
      work: deferred?.work === true,
      backup: deferred?.backup === true,
    },
  };
}

const projectStatusFromRaw = (value: unknown): Project['status'] => {
  const status = stringValue(value);
  return (
    (
      {
        planifie: 'planned',
        en_cours: 'in_progress',
        en_pause: 'paused',
        termine: 'completed',
        cloture: 'closed',
      } as Record<string, Project['status']>
    )[status] ?? 'planned'
  );
};
const quoteStatusFromRaw = (value: unknown): Quote['status'] => {
  const status = stringValue(value);
  return (
    (
      {
        brouillon: 'draft',
        emis: 'issued',
        accepte: 'accepted',
        refuse: 'refused',
        expire: 'expired',
        annulee: 'cancelled',
      } as Record<string, Quote['status']>
    )[status] ?? 'draft'
  );
};
const invoiceStatusFromRaw = (value: unknown): Invoice['status'] => {
  const status = stringValue(value);
  return (
    (
      {
        brouillon: 'draft',
        emise: 'issued',
        partiellement_payee: 'partially_paid',
        payee: 'paid',
        annulee: 'cancelled',
        en_retard: 'issued',
      } as Record<string, Invoice['status']>
    )[status] ?? 'draft'
  );
};

const salesOrderStatusFromRaw = (value: unknown): SalesOrder['status'] => {
  const status = stringValue(value);
  if (status === 'draft' || status === 'brouillon') return 'draft';
  if (
    status === 'confirmed' ||
    status === 'confirme' ||
    status === 'confirmee' ||
    status === 'partially_delivered' ||
    status === 'partiellement_livree' ||
    status === 'delivered' ||
    status === 'livree'
  )
    return 'confirmed';
  if (status === 'closed' || status === 'cloture' || status === 'cloturee')
    return 'closed';
  if (status === 'cancelled' || status === 'annule' || status === 'annulee')
    return 'cancelled';
  return 'draft';
};

const recurrenceFrequencyFromRaw = (value: unknown): RecurrenceFrequency => {
  const frequency = stringValue(value);
  if (
    frequency === 'monthly' ||
    frequency === 'quarterly' ||
    frequency === 'yearly'
  )
    return frequency;
  return 'monthly';
};

const recurrenceScheduleStatusFromRaw = (
  value: unknown,
): RecurrenceSchedule['status'] => {
  const status = stringValue(value);
  if (
    status === 'active' ||
    status === 'paused' ||
    status === 'review_required' ||
    status === 'completed'
  )
    return status;
  // Un état inconnu ne doit jamais relancer silencieusement la génération.
  return 'review_required';
};

export function recurrenceScheduleFromRaw(row: RawRecord): RecurrenceSchedule {
  const rawFrequency = stringValue(row.frequency);
  const rawStatus = stringValue(row.status);
  const anchorDay = Math.trunc(numberValue(row.anchor_day));
  const paymentTermsDays = Math.trunc(numberValue(row.payment_terms_days));
  const invalidFrequency = !['monthly', 'quarterly', 'yearly'].includes(
    rawFrequency,
  );
  const invalidStatus = ![
    'active',
    'paused',
    'review_required',
    'completed',
  ].includes(rawStatus);
  return {
    id: stringValue(row.id),
    sourceSalesOrderId: stringValue(row.source_sales_order_id),
    frequency: recurrenceFrequencyFromRaw(row.frequency),
    anchorDate: stringValue(row.anchor_date),
    anchorDay: anchorDay >= 1 && anchorDay <= 31 ? anchorDay : 1,
    anchorIsMonthEnd: boolValue(row.anchor_is_month_end),
    paymentTermsDays:
      paymentTermsDays >= 0 && paymentTermsDays <= 365 ? paymentTermsDays : 30,
    nextScheduledFor: stringValue(row.next_scheduled_for),
    endDate: nullableString(row.end_date),
    status:
      invalidFrequency || invalidStatus
        ? 'review_required'
        : recurrenceScheduleStatusFromRaw(row.status),
    reviewReason:
      nullableString(row.review_reason) ??
      (invalidFrequency || invalidStatus
        ? 'La planification locale contient une valeur non reconnue et doit être contrôlée.'
        : null),
    sourceOrderSnapshotSha256: stringValue(row.source_order_snapshot_sha256),
    sourceSnapshotSha256: stringValue(row.source_snapshot_sha256),
    completedAt: nullableString(row.completed_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

export function recurrenceOccurrenceFromRaw(
  row: RawRecord,
): RecurrenceOccurrence {
  const sequence = Math.trunc(numberValue(row.sequence));
  return {
    sequence: Math.max(0, sequence),
    id: stringValue(row.id),
    scheduleId: stringValue(row.schedule_id),
    scheduledFor: stringValue(row.scheduled_for),
    invoiceId: stringValue(row.invoice_id),
    status:
      stringValue(row.status) === 'draft_created' ? 'draft_created' : 'unknown',
    message: nullableString(row.message),
    requestId: stringValue(row.request_id),
    payloadSha256: stringValue(row.payload_sha256),
    sourceSnapshotSha256: stringValue(row.source_snapshot_sha256),
    createdAt: stringValue(row.created_at),
    invoiceStatus: invoiceStatusFromRaw(row.invoice_status),
    invoiceNumber: nullableString(row.invoice_number),
  };
}

const fulfillmentModeFromRaw = (
  value: unknown,
  catalogItemId: string | null,
): SalesOrderFulfillmentMode => {
  const mode = stringValue(value);
  if (
    mode === 'stocked_delivery' ||
    mode === 'stocked' ||
    mode === 'tracked_product'
  )
    return 'stocked_delivery';
  if (
    mode === 'untracked_delivery' ||
    mode === 'delivery' ||
    mode === 'untracked_product'
  )
    return 'untracked_delivery';
  if (mode === 'direct' || mode === 'service') return 'direct';
  return catalogItemId ? 'untracked_delivery' : 'direct';
};

const deliveryNoteStatusFromRaw = (value: unknown): DeliveryNote['status'] => {
  const status = stringValue(value);
  if (status === 'issued' || status === 'emis' || status === 'emise')
    return 'issued';
  if (status === 'reversed' || status === 'extourne' || status === 'extournee')
    return 'reversed';
  return 'draft';
};

function salesOrderLineFromRaw(row: RawRecord): SalesOrderLine {
  const catalogItemId = nullableString(row.catalog_item_id);
  const quantityMilli = numberValue(row.quantity_milli);
  const unitPriceCents = numberValue(row.unit_price_cents);
  const lineNetCents = numberValue(row.line_net_cents);
  const lineVatCents = numberValue(row.line_vat_cents);
  return {
    id: stringValue(row.id),
    salesOrderId: stringValue(row.sales_order_id) || stringValue(row.order_id),
    catalogItemId,
    position: numberValue(row.position),
    description: stringValue(row.description),
    quantityMilli,
    cancelledQuantityMilli: numberValue(row.cancelled_quantity_milli),
    unit: stringValue(row.unit) || 'unité',
    unitPriceCents,
    discountBp: numberValue(row.discount_bp),
    vatBp: numberValue(row.vat_bp),
    lineGrossCents:
      numberValue(row.line_gross_cents) ||
      Math.round((quantityMilli * unitPriceCents) / 1_000),
    lineNetCents,
    lineVatCents,
    lineTotalCents:
      numberValue(row.line_total_cents) || lineNetCents + lineVatCents,
    fulfillmentMode: fulfillmentModeFromRaw(
      row.fulfillment_mode,
      catalogItemId,
    ),
  };
}

function deliveryNoteLineFromRaw(row: RawRecord): DeliveryNoteLine {
  return {
    id: stringValue(row.id),
    deliveryNoteId: stringValue(row.delivery_note_id),
    salesOrderLineId:
      stringValue(row.sales_order_line_id) || stringValue(row.order_line_id),
    position: numberValue(row.position),
    quantityMilli: numberValue(row.quantity_milli),
    description: stringValue(row.description),
    unit: stringValue(row.unit),
  };
}

function frozenSalesOrderRecordFromRaw(row: RawRecord): FrozenSalesOrderRecord {
  return {
    id: stringValue(row.id),
    clientId: stringValue(row.client_id),
    projectId: nullableString(row.project_id),
    quoteId: nullableString(row.quote_id),
    number: stringValue(row.number),
    title: stringValue(row.title) || 'Commande client',
    status: salesOrderStatusFromRaw(row.status),
    orderDate: stringValue(row.order_date),
    currency: stringValue(row.currency) || 'CHF',
    subtotalCents: numberValue(row.subtotal_cents),
    discountCents: numberValue(row.discount_cents),
    vatCents: numberValue(row.vat_cents),
    totalCents: numberValue(row.total_cents),
    notes: stringValue(row.notes),
    terms: stringValue(row.terms),
    confirmedAt: nullableString(row.confirmed_at),
  };
}

function salesOrderSnapshotFromRaw(
  value: unknown,
  dataDir = '',
): FrozenSalesOrderSnapshot | null {
  const root = parsedSnapshot(value);
  if (
    !root ||
    stringValue(root.schema) !== 'helvichantier.sales_order_snapshot.v1'
  )
    return null;
  return {
    capturedAt: stringValue(root.captured_at),
    issuer: frozenIssuerFromRaw(recordValue(root.issuer), dataDir),
    customer: frozenCustomerFromRaw(recordValue(root.customer)),
    order: frozenSalesOrderRecordFromRaw(recordValue(root.order)),
    lines: rawArray(root.lines).map(salesOrderLineFromRaw),
  };
}

function deliveryNoteSnapshotFromRaw(
  value: unknown,
  dataDir = '',
): FrozenDeliveryNoteSnapshot | null {
  const root = parsedSnapshot(value);
  if (
    !root ||
    stringValue(root.schema) !== 'helvichantier.delivery_note_snapshot.v1'
  )
    return null;
  const note = recordValue(root.delivery_note);
  return {
    capturedAt: stringValue(root.captured_at),
    issuer: frozenIssuerFromRaw(recordValue(root.issuer), dataDir),
    customer: frozenCustomerFromRaw(recordValue(root.customer)),
    deliveryNote: {
      id: stringValue(note.id),
      salesOrderId: stringValue(note.sales_order_id),
      number: stringValue(note.number),
      status: deliveryNoteStatusFromRaw(note.status),
      deliveryDate: stringValue(note.delivery_date),
      reference: stringValue(note.reference),
      notes: stringValue(note.notes),
      issuedAt: nullableString(note.issued_at),
    },
    lines: rawArray(root.lines).map(deliveryNoteLineFromRaw),
    order: frozenSalesOrderRecordFromRaw(recordValue(root.order)),
  };
}

function stockReservationEventFromRaw(row: RawRecord): StockReservationEvent {
  const rawEventType =
    stringValue(row.event_type) || stringValue(row.movement_type);
  const eventType: StockReservationEvent['eventType'] =
    rawEventType === 'delivery' ||
    rawEventType === 'release' ||
    rawEventType === 'restore'
      ? rawEventType
      : 'reserve';
  return {
    sequence: numberValue(row.sequence),
    id: stringValue(row.id),
    catalogItemId: stringValue(row.catalog_item_id),
    salesOrderId: stringValue(row.sales_order_id) || stringValue(row.order_id),
    salesOrderLineId:
      stringValue(row.sales_order_line_id) || stringValue(row.order_line_id),
    deliveryNoteLineId: nullableString(row.delivery_note_line_id),
    eventType,
    quantityDeltaMilli: numberValue(row.quantity_delta_milli),
    lineReservedAfterMilli:
      numberValue(row.line_reserved_after_milli) ||
      numberValue(row.reserved_after_milli),
    catalogReservedAfterMilli:
      numberValue(row.catalog_reserved_after_milli) ||
      numberValue(row.total_reserved_after_milli),
    reason: stringValue(row.reason),
    createdAt: stringValue(row.created_at),
  };
}

const planningStatusFromRaw = (value: unknown): ProjectTask['status'] => {
  const status = stringValue(value);
  if (
    status === 'todo' ||
    status === 'in_progress' ||
    status === 'done' ||
    status === 'cancelled'
  )
    return status;
  throw new Error(`État de planning local inconnu : ${status || 'vide'}.`);
};

const planningPriorityFromRaw = (value: unknown): ProjectTask['priority'] => {
  const priority = stringValue(value);
  if (
    priority === 'low' ||
    priority === 'normal' ||
    priority === 'high' ||
    priority === 'urgent'
  )
    return priority;
  throw new Error(
    `Priorité de planning locale inconnue : ${priority || 'vide'}.`,
  );
};

function lineFromRaw(row: RawRecord): DocumentLine {
  return {
    id: stringValue(row.id),
    catalogItemId: stringValue(row.catalog_item_id) || null,
    description: stringValue(row.description),
    quantity: numberValue(row.quantity),
    unit: stringValue(row.unit),
    unitPriceCents: numberValue(row.unit_price_cents),
    discountBp: numberValue(row.discount_bp),
    vatRateBp: numberValue(row.vat_bp),
  };
}

function depositBasisLinesFromRaw(value: unknown): DocumentLine[] | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return null;
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter(
      (line): line is RawRecord =>
        Boolean(line && typeof line === 'object' && !Array.isArray(line)),
    )
    .map(lineFromRaw);
}

function catalogItemFromRaw(row: RawRecord): CatalogItem {
  const kind = stringValue(row.kind) === 'product' ? 'product' : 'service';
  return {
    id: stringValue(row.id),
    kind,
    sku: stringValue(row.sku) || null,
    name: stringValue(row.name),
    description: stringValue(row.description),
    unit: stringValue(row.unit),
    salesPriceCents: numberValue(row.sales_price_cents),
    purchaseCostCents: numberValue(row.purchase_cost_cents),
    vatBp: numberValue(row.vat_bp),
    trackStock: kind === 'product' && boolValue(row.track_stock),
    stockQuantityMilli:
      kind === 'product' ? numberValue(row.stock_quantity_milli) : 0,
    reorderLevelMilli:
      kind === 'product' ? numberValue(row.reorder_level_milli) : 0,
    archivedAt: stringValue(row.archived_at) || null,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function stockMovementFromRaw(row: RawRecord): StockMovement {
  const movementType = stringValue(row.movement_type);
  const sourceType = stringValue(row.source_type);
  const reversesMovement = Boolean(stringValue(row.reverses_stock_movement_id));
  const normalizedSource: StockMovement['sourceType'] =
    sourceType === 'delivery' && reversesMovement
      ? 'delivery_reversal'
      : sourceType === 'receipt' && reversesMovement
        ? 'receipt_reversal'
        : sourceType === 'invoice' ||
            sourceType === 'opening' ||
            sourceType === 'delivery' ||
            sourceType === 'delivery_reversal' ||
            sourceType === 'receipt' ||
            sourceType === 'receipt_reversal'
          ? sourceType
          : 'manual';
  return {
    sequence: numberValue(row.sequence),
    id: stringValue(row.id),
    sourceKey: stringValue(row.source_key),
    requestId: stringValue(row.request_id) || null,
    catalogItemId: stringValue(row.catalog_item_id),
    movementType:
      movementType === 'entry' || movementType === 'correction'
        ? movementType
        : 'exit',
    quantityDeltaMilli: numberValue(row.quantity_delta_milli),
    balanceAfterMilli: numberValue(row.balance_after_milli),
    reason: stringValue(row.reason),
    reference: stringValue(row.reference) || null,
    movementDate: stringValue(row.movement_date),
    sourceType: normalizedSource,
    invoiceId: stringValue(row.invoice_id) || null,
    invoiceItemId: stringValue(row.invoice_item_id) || null,
    deliveryNoteId: stringValue(row.delivery_note_id) || null,
    deliveryNoteLineId: stringValue(row.delivery_note_line_id) || null,
    stockReceiptId: stringValue(row.stock_receipt_id) || null,
    stockReceiptLineId: stringValue(row.stock_receipt_line_id) || null,
    createdAt: stringValue(row.created_at),
  };
}

function supplierFromRaw(row: RawRecord): Supplier {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    contactName: stringValue(row.contact_name),
    email: stringValue(row.email),
    phone: stringValue(row.phone),
    address: stringValue(row.address),
    uidNumber: stringValue(row.uid_number),
    iban: stringValue(row.iban),
    currency: stringValue(row.currency) || 'CHF',
    paymentTermsDays: numberValue(row.payment_terms_days),
    notes: stringValue(row.notes),
    archivedAt: stringValue(row.archived_at) || null,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function purchaseCostFromRaw(row: RawRecord, vatField: string): Pick<Expense, 'costCents' | 'costReviewRequired' | 'costBasis'> {
  const rawCost = row.cost_cents;
  const parsedCost = typeof rawCost === 'number' ? rawCost : typeof rawCost === 'string' && rawCost.trim() ? Number(rawCost) : NaN;
  const cost = Number.isSafeInteger(parsedCost) && parsedCost >= 0 ? parsedCost : undefined;
  const basis = stringValue(row.cost_basis);
  const knownBasis = basis === 'accounted' || basis === 'estimated' || basis === 'review';
  return {
    costCents: cost,
    costReviewRequired: boolValue(row.cost_review_required) || basis === 'review'
      || (rawCost != null && (cost === undefined || !knownBasis))
      || (cost === undefined && numberValue(row[vatField]) !== 0),
    costBasis: knownBasis ? basis : undefined,
  };
}

function supplierInvoiceItemFromRaw(row: RawRecord): SupplierInvoiceItem {
  return {
    ...purchaseCostFromRaw(row, 'line_vat_cents'),
    id: stringValue(row.id),
    supplierInvoiceId: stringValue(row.supplier_invoice_id),
    position: numberValue(row.position),
    description: stringValue(row.description),
    quantityMilli: numberValue(row.quantity_milli),
    unit: stringValue(row.unit) || 'unité',
    unitPriceCents: numberValue(row.unit_price_cents),
    discountBp: numberValue(row.discount_bp),
    vatBp: numberValue(row.vat_bp),
    netCents: numberValue(row.line_net_cents),
    vatCents: numberValue(row.line_vat_cents),
    totalCents: numberValue(row.line_total_cents),
    category: stringValue(row.category),
    expenseAccountId: stringValue(row.expense_account_id) || null,
    postedExpenseAccountId: stringValue(row.posted_expense_account_id) || null,
    projectId: stringValue(row.project_id) || null,
  };
}

const supplierOrderStatusFromRaw = (
  value: unknown,
): SupplierOrder['status'] => {
  const status = stringValue(value);
  if (status === 'confirmed' || status === 'closed' || status === 'cancelled')
    return status;
  return 'draft';
};

const supplierOrderFulfillmentModeFromRaw = (
  value: unknown,
): SupplierOrderFulfillmentMode => {
  const mode = stringValue(value);
  if (mode === 'stocked_receipt' || mode === 'direct') return mode;
  return 'untracked_receipt';
};

function supplierOrderLineFromRaw(row: RawRecord): SupplierOrderLine {
  const quantityMilli = numberValue(row.quantity_milli);
  const unitPriceCents = numberValue(row.unit_price_cents);
  const lineNetCents = numberValue(row.line_net_cents);
  const lineVatCents = numberValue(row.line_vat_cents);
  return {
    id: stringValue(row.id),
    supplierOrderId: stringValue(row.supplier_order_id),
    catalogItemId: nullableString(row.catalog_item_id),
    position: numberValue(row.position),
    description: stringValue(row.description),
    quantityMilli,
    cancelledQuantityMilli: numberValue(row.cancelled_quantity_milli),
    receivedQuantityMilli: numberValue(row.received_quantity_milli),
    matchedQuantityMilli: numberValue(row.matched_quantity_milli),
    remainingReceivableMilli: numberValue(row.remaining_receivable_milli),
    remainingMatchableMilli: numberValue(row.remaining_matchable_milli),
    unit: stringValue(row.unit) || 'unité',
    unitPriceCents,
    discountBp: numberValue(row.discount_bp),
    vatBp: numberValue(row.vat_bp),
    lineNetCents,
    lineVatCents,
    lineTotalCents:
      numberValue(row.line_total_cents) || lineNetCents + lineVatCents,
    category: stringValue(row.category),
    expenseAccountId: nullableString(row.expense_account_id),
    projectId: nullableString(row.project_id),
    fulfillmentMode: supplierOrderFulfillmentModeFromRaw(row.fulfillment_mode),
  };
}

const supplierReceiptStatusFromRaw = (
  value: unknown,
): SupplierReceipt['status'] => {
  const status = stringValue(value);
  if (status === 'issued' || status === 'reversed') return status;
  return 'draft';
};

function supplierCreditNoteItemFromRaw(row: RawRecord): SupplierCreditNoteItem {
  const invoiceItem = supplierInvoiceItemFromRaw({
    ...row,
    supplier_invoice_id: '',
  });
  const { supplierInvoiceId: _supplierInvoiceId, ...item } = invoiceItem;
  return {
    ...item,
    supplierCreditNoteId: stringValue(row.supplier_credit_note_id),
  };
}

function supplierInvoicePaymentFromRaw(row: RawRecord): SupplierInvoicePayment {
  return {
    id: stringValue(row.id),
    supplierInvoiceId: stringValue(row.supplier_invoice_id),
    requestId: stringValue(row.request_id),
    date: stringValue(row.date),
    amountCents: numberValue(row.amount_cents),
    method: stringValue(row.method),
    reference: stringValue(row.reference),
    notes: stringValue(row.notes),
    journalEntryId: stringValue(row.journal_entry_id),
    createdAt: stringValue(row.created_at),
  };
}

export function attachmentFromRaw(row: RawRecord): Attachment {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id) || null,
    entityType: stringValue(row.entity_type),
    entityId: stringValue(row.entity_id) || null,
    originalName: stringValue(row.original_name),
    mimeType: stringValue(row.mime_type),
    sizeBytes: Math.max(0, numberValue(row.size_bytes)),
    sha256: stringValue(row.sha256),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

export function attachmentsForSupplierInvoice(
  attachments: Attachment[],
  supplierInvoiceId: string,
): Attachment[] {
  return attachments
    .filter(
      (attachment) =>
        attachment.entityType === 'supplier_invoice' &&
        attachment.entityId === supplierInvoiceId,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function frozenIssuerFromRaw(row: RawRecord, dataDir = ''): FrozenIssuer {
  const extra = parseExtra(row);
  return {
    companyName: stringValue(row.company_name),
    legalForm: stringValue(row.legal_form),
    ownerName: stringValue(row.owner_name),
    email: stringValue(row.email),
    phone: stringValue(row.phone),
    addressLine1: stringValue(row.address_line1),
    addressLine2: stringValue(row.address_line2),
    buildingNumber:
      stringValue(row.building_number) ||
      extra.organization?.address?.buildingNumber ||
      '',
    postalCode: stringValue(row.postal_code),
    city: stringValue(row.city),
    canton: stringValue(row.canton),
    country: stringValue(row.country),
    uidNumber: stringValue(row.uid_number),
    vatNumber: stringValue(row.vat_number),
    vatRegistered: boolValue(row.vat_registered),
    iban: stringValue(row.iban),
    bankName: stringValue(row.bank_name),
    currency: stringValue(row.currency) || 'CHF',
    logoPath: rebaseStoredBrandingPath(row.logo_path, dataDir),
  };
}

function frozenCustomerFromRaw(row: RawRecord): FrozenCustomer {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    company: stringValue(row.company),
    contactPerson: stringValue(row.contact_person),
    email: stringValue(row.email),
    phone: stringValue(row.phone),
    addressLine1: stringValue(row.address_line1),
    addressLine2: stringValue(row.address_line2),
    postalCode: stringValue(row.postal_code),
    city: stringValue(row.city),
    canton: stringValue(row.canton),
    country: stringValue(row.country),
  };
}

function storedQrBillFromRaw(
  value: unknown,
  fallbackInvoiceId = '',
): StoredSwissQrBill | null {
  const row = recordValue(value);
  const inputRow = Object.keys(recordValue(row.input)).length
    ? recordValue(row.input)
    : parsedSnapshot(row.input_json);
  const payload = stringValue(row.payload);
  if (!inputRow || !payload) return null;
  let lines = Array.isArray(row.lines) ? row.lines.map(stringValue) : [];
  if (!lines.length && typeof row.lines_json === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.lines_json);
      if (Array.isArray(parsed)) lines = parsed.map(stringValue);
    } catch {
      lines = [];
    }
  }
  return {
    invoiceId: stringValue(row.invoice_id) || fallbackInvoiceId,
    input: qrInputFromRaw(inputRow),
    payload,
    lines: lines.length ? lines : payload.split('\n'),
    referenceType: stringValue(
      row.reference_type,
    ) as StoredSwissQrBill['referenceType'],
    isQrIban: boolValue(row.is_qr_iban),
    characterCount: numberValue(row.character_count),
    byteCount: numberValue(row.byte_count),
    frozenAt: stringValue(row.frozen_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    frozen: boolValue(row.frozen) || Boolean(stringValue(row.frozen_at)),
  };
}

function documentSnapshotFromRaw(
  value: unknown,
  dataDir = '',
): FrozenDocumentSnapshot | null {
  const root = parsedSnapshot(value);
  if (
    !root ||
    stringValue(root.schema) !== 'helvichantier.document_snapshot.v1'
  )
    return null;
  const document = recordValue(root.document);
  return {
    capturedAt: stringValue(root.captured_at),
    issuer: frozenIssuerFromRaw(recordValue(root.issuer), dataDir),
    customer: frozenCustomerFromRaw(recordValue(root.customer)),
    document: {
      id: stringValue(document.id),
      number: stringValue(document.number),
      clientId: stringValue(document.client_id),
      projectId: nullableString(document.project_id),
      quoteId: nullableString(document.quote_id),
      originalInvoiceId: nullableString(document.original_invoice_id),
      title: stringValue(document.title),
      type: stringValue(document.type),
      issueDate: stringValue(document.issue_date),
      validUntil: stringValue(document.valid_until),
      dueDate: stringValue(document.due_date),
      serviceDateFrom: stringValue(document.service_date_from),
      serviceDateTo: stringValue(document.service_date_to),
      currency: stringValue(document.currency) || 'CHF',
      notes: stringValue(document.notes),
      terms: stringValue(document.terms),
      depositPercentageBp:
        numberValue(document.deposit_percentage_bp) || null,
      depositBasisLines: depositBasisLinesFromRaw(document.deposit_basis_json),
    },
    items: rawArray(root.items).map(lineFromRaw),
    qrBill: storedQrBillFromRaw(root.qr_bill, stringValue(document.id)),
  };
}

function normalizeWorkspace(raw: RawWorkspace, appState: AppState): Workspace {
  const quoteItems = raw.quote_items ?? [];
  const salesOrderLines = (raw.sales_order_lines ?? []).map(
    salesOrderLineFromRaw,
  );
  const deliveryNoteLines = (raw.delivery_note_lines ?? []).map(
    deliveryNoteLineFromRaw,
  );
  const invoiceItems = raw.invoice_items ?? [];
  const invoiceQrBills = raw.invoice_qr_bills ?? [];
  const payslipItems = raw.payslip_items ?? [];
  const supplierInvoiceItems = (raw.supplier_invoice_items ?? []).map(
    supplierInvoiceItemFromRaw,
  );
  const supplierInvoicePayments = (raw.supplier_payments ?? []).map(
    supplierInvoicePaymentFromRaw,
  );
  const supplierOrderLines = (raw.supplier_order_lines ?? []).map(
    supplierOrderLineFromRaw,
  );
  const supplierReceiptLines: SupplierReceiptLine[] = (
    raw.supplier_receipt_lines ?? []
  ).map((row) => {
    const supplierOrderLineId = stringValue(row.supplier_order_line_id);
    const orderLine = supplierOrderLines.find(
      (line) => line.id === supplierOrderLineId,
    );
    return {
      id: stringValue(row.id),
      supplierReceiptId: stringValue(row.supplier_receipt_id),
      supplierOrderLineId,
      position: numberValue(row.position),
      quantityMilli: numberValue(row.quantity_milli),
      description:
        stringValue(row.description) ||
        orderLine?.description ||
        'Article fournisseur',
      unit: stringValue(row.unit) || orderLine?.unit || 'unité',
    };
  });
  const supplierCreditNoteItems = (raw.supplier_credit_note_items ?? []).map(
    supplierCreditNoteItemFromRaw,
  );
  const supplierCreditAllocations: SupplierCreditAllocation[] = (
    raw.supplier_credit_allocations ?? []
  ).map((row) => ({
    id: stringValue(row.id),
    sequence: numberValue(row.sequence),
    requestId: stringValue(row.request_id),
    supplierCreditNoteId: stringValue(row.supplier_credit_note_id),
    supplierInvoiceId: stringValue(row.supplier_invoice_id),
    eventType: stringValue(row.event_type) === 'reverse' ? 'reverse' : 'apply',
    reversesAllocationId: nullableString(row.reverses_allocation_id),
    amountCents: numberValue(row.amount_cents),
    reason: stringValue(row.reason),
    effectiveDate: nullableString(row.effective_date),
    createdAt: stringValue(row.created_at),
  }));
  const supplierExpenseReclassificationLines: SupplierExpenseReclassificationLine[] =
    (raw.supplier_expense_reclassification_lines ?? []).map((row) => ({
      id: stringValue(row.id),
      reclassificationId: stringValue(row.reclassification_id),
      supplierInvoiceItemId: stringValue(row.supplier_invoice_item_id),
      oldExpenseAccountId: nullableString(row.old_expense_account_id),
      newExpenseAccountId: stringValue(row.new_expense_account_id),
      amountCents: numberValue(row.amount_cents),
      projectId: nullableString(row.project_id),
      createdAt: stringValue(row.created_at),
    }));
  const supplierInvoiceAttachments = (raw.attachments ?? [])
    .map(attachmentFromRaw)
    .filter(
      (attachment) =>
        attachment.entityType === 'supplier_invoice' && attachment.entityId,
    );
  const clients: Client[] = (raw.clients ?? []).map((row) => ({
    id: stringValue(row.id),
    name: stringValue(row.contact_person) || stringValue(row.name),
    company: stringValue(row.company),
    email: stringValue(row.email),
    phone: stringValue(row.phone),
    address: [
      stringValue(row.address_line1),
      stringValue(row.address_line2),
      [stringValue(row.postal_code), stringValue(row.city)]
        .filter(Boolean)
        .join(' '),
      stringValue(row.canton),
      stringValue(row.country),
    ]
      .filter(Boolean)
      .join('\n'),
    addressLine1: stringValue(row.address_line1),
    addressLine2: stringValue(row.address_line2),
    buildingNumber: stringValue(row.address_line2),
    postalCode: stringValue(row.postal_code),
    city: stringValue(row.city),
    canton: stringValue(row.canton),
    country: stringValue(row.country),
    uidNumber: '',
    notes: stringValue(row.notes),
    archivedAt: nullableString(row.archived_at),
  }));
  const catalogItems = (raw.catalog_items ?? []).map(catalogItemFromRaw);
  const stockMovements = (raw.stock_movements ?? []).map(stockMovementFromRaw);
  const stockReservationEvents = (raw.stock_reservation_events ?? []).map(
    stockReservationEventFromRaw,
  );
  const stockAvailability: StockAvailability[] = raw.stock_availability?.length
    ? raw.stock_availability.map((row) => {
        const onHandMilli = numberValue(row.on_hand_milli);
        const reservedMilli = numberValue(row.reserved_milli);
        return {
          catalogItemId: stringValue(row.catalog_item_id),
          onHandMilli,
          reservedMilli,
          availableMilli:
            row.available_milli === undefined
              ? onHandMilli - reservedMilli
              : numberValue(row.available_milli),
        };
      })
    : catalogItems
        .filter((item) => item.kind === 'product' && item.trackStock)
        .map((item) => {
          const reservedMilli = stockReservationEvents
            .filter((event) => event.catalogItemId === item.id)
            .reduce((total, event) => total + event.quantityDeltaMilli, 0);
          return {
            catalogItemId: item.id,
            onHandMilli: item.stockQuantityMilli,
            reservedMilli,
            availableMilli: item.stockQuantityMilli - reservedMilli,
          };
        });
  const suppliers = (raw.suppliers ?? []).map(supplierFromRaw);
  const projects: Project[] = (raw.projects ?? []).map((row) => ({
    id: stringValue(row.id),
    clientId: stringValue(row.client_id),
    name: stringValue(row.name),
    address: [
      stringValue(row.address_line1),
      stringValue(row.address_line2),
      [stringValue(row.postal_code), stringValue(row.city)]
        .filter(Boolean)
        .join(' '),
      stringValue(row.canton),
    ]
      .filter(Boolean)
      .join('\n'),
    status: projectStatusFromRaw(row.status),
    plannedStart: stringValue(row.planned_start_date),
    plannedEnd: stringValue(row.planned_end_date),
    actualStart: stringValue(row.actual_start_date),
    actualEnd: stringValue(row.actual_end_date),
    budgetCents: numberValue(row.budget_cents),
    plannedMinutes: numberValue(row.planned_minutes),
    notes: stringValue(row.notes) || stringValue(row.description),
  }));
  const projectMilestones: ProjectMilestone[] = (
    raw.project_milestones ?? []
  ).map((row) => ({
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    title: stringValue(row.title),
    description: stringValue(row.description),
    dueDate: stringValue(row.due_date),
    status: planningStatusFromRaw(row.status),
    priority: planningPriorityFromRaw(row.priority),
    sortOrder: numberValue(row.sort_order),
    employeeId: nullableString(row.employee_id),
    completedAt: nullableString(row.completed_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  }));
  const projectTasks: ProjectTask[] = (raw.project_tasks ?? []).map((row) => ({
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    milestoneId: nullableString(row.milestone_id),
    title: stringValue(row.title),
    description: stringValue(row.description),
    dueDate: stringValue(row.due_date),
    status: planningStatusFromRaw(row.status),
    priority: planningPriorityFromRaw(row.priority),
    sortOrder: numberValue(row.sort_order),
    employeeId: nullableString(row.employee_id),
    completedAt: nullableString(row.completed_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  }));
  const agendaEvents: AgendaEvent[] = (raw.agenda_events ?? []).map((row) => ({
    id: stringValue(row.id),
    title: stringValue(row.title),
    startDate: stringValue(row.start_date),
    endDate: stringValue(row.end_date),
    allDay: boolValue(row.all_day),
    startTime: nullableString(row.start_time),
    endTime: nullableString(row.end_time),
    kind: ['appointment', 'visit', 'deadline', 'other'].includes(
      stringValue(row.kind),
    )
      ? (stringValue(row.kind) as AgendaEvent['kind'])
      : 'other',
    status: ['scheduled', 'completed', 'cancelled'].includes(
      stringValue(row.status),
    )
      ? (stringValue(row.status) as AgendaEvent['status'])
      : 'scheduled',
    location: stringValue(row.location),
    notes: stringValue(row.notes),
    projectId: nullableString(row.project_id),
    employeeId: nullableString(row.employee_id),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  }));
  const quotes: Quote[] = (raw.quotes ?? []).map((row) => ({
    id: stringValue(row.id),
    number: stringValue(row.number),
    clientId: stringValue(row.client_id),
    projectId: stringValue(row.project_id) || null,
    title: stringValue(row.title),
    issueDate: stringValue(row.issue_date),
    validUntil: stringValue(row.valid_until),
    currency: stringValue(row.currency) || 'CHF',
    status: quoteStatusFromRaw(row.status),
    lines: quoteItems
      .filter((item) => stringValue(item.quote_id) === stringValue(row.id))
      .sort((a, b) => numberValue(a.position) - numberValue(b.position))
      .map(lineFromRaw),
    notes: stringValue(row.notes),
    terms: stringValue(row.terms),
    createdAt: stringValue(row.created_at),
    snapshot: documentSnapshotFromRaw(row.snapshot_json, appState.data_dir),
  }));
  const salesOrders: SalesOrder[] = (raw.sales_orders ?? []).map((row) => {
    const id = stringValue(row.id);
    const orderLines = salesOrderLines
      .filter((line) => line.salesOrderId === id)
      .sort((left, right) => left.position - right.position);
    const subtotalCents = numberValue(row.subtotal_cents);
    const vatCents = numberValue(row.vat_cents);
    return {
      id,
      clientId: stringValue(row.client_id),
      projectId: nullableString(row.project_id),
      quoteId: nullableString(row.quote_id),
      number: stringValue(row.number),
      title: stringValue(row.title) || 'Commande client',
      status: salesOrderStatusFromRaw(row.status),
      orderDate: stringValue(row.order_date) || stringValue(row.issue_date),
      currency: stringValue(row.currency) || 'CHF',
      subtotalCents,
      discountCents: numberValue(row.discount_cents),
      vatCents,
      totalCents:
        numberValue(row.total_cents) ||
        orderLines.reduce((total, line) => total + line.lineTotalCents, 0) ||
        subtotalCents + vatCents,
      notes: stringValue(row.notes),
      terms: stringValue(row.terms),
      confirmedAt: nullableString(row.confirmed_at),
      closedAt: nullableString(row.closed_at),
      cancelledAt: nullableString(row.cancelled_at),
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
      lines: orderLines,
      snapshot: salesOrderSnapshotFromRaw(row.snapshot_json, appState.data_dir),
    };
  });
  const recurrenceSchedules = (raw.recurrence_schedules ?? []).map(
    recurrenceScheduleFromRaw,
  );
  const recurrenceOccurrences = (raw.recurrence_occurrences ?? []).map(
    recurrenceOccurrenceFromRaw,
  );
  const deliveryNotes: DeliveryNote[] = (raw.delivery_notes ?? []).map(
    (row) => {
      const id = stringValue(row.id);
      return {
        id,
        salesOrderId:
          stringValue(row.sales_order_id) || stringValue(row.order_id),
        number: stringValue(row.number),
        status: deliveryNoteStatusFromRaw(row.status),
        deliveryDate:
          stringValue(row.delivery_date) || stringValue(row.issue_date),
        reference: stringValue(row.reference),
        notes: stringValue(row.notes),
        issuedAt: nullableString(row.issued_at),
        reversedAt: nullableString(row.reversed_at),
        createdAt: stringValue(row.created_at),
        updatedAt: stringValue(row.updated_at),
        lines: deliveryNoteLines
          .filter((line) => line.deliveryNoteId === id)
          .sort((left, right) => left.position - right.position),
        snapshot: deliveryNoteSnapshotFromRaw(
          row.snapshot_json,
          appState.data_dir,
        ),
      };
    },
  );
  const salesOrderInvoiceBatches: SalesOrderInvoiceBatch[] = (
    raw.sales_order_invoice_batches ?? []
  ).map((row) => {
    const rawRole = stringValue(row.role) || stringValue(row.invoice_role);
    return {
      id: stringValue(row.id),
      salesOrderId:
        stringValue(row.sales_order_id) || stringValue(row.order_id),
      invoiceId: stringValue(row.invoice_id),
      role: rawRole === 'final' || rawRole === 'finale' ? 'final' : 'partial',
      createdAt: stringValue(row.created_at),
    };
  });
  const salesOrderInvoiceAllocations: SalesOrderInvoiceAllocation[] = (
    raw.sales_order_invoice_allocations ?? []
  ).map((row) => ({
    id: stringValue(row.id),
    batchId: stringValue(row.batch_id),
    salesOrderLineId:
      stringValue(row.sales_order_line_id) || stringValue(row.order_line_id),
    deliveryNoteLineId: nullableString(row.delivery_note_line_id),
    invoiceItemId: nullableString(row.invoice_item_id),
    quantityMilli: numberValue(row.quantity_milli),
    grossCentsSnapshot:
      numberValue(row.gross_cents) ||
      numberValue(row.gross_cents_snapshot) ||
      numberValue(row.line_gross_cents),
    netCentsSnapshot:
      numberValue(row.net_cents) ||
      numberValue(row.net_cents_snapshot) ||
      numberValue(row.line_net_cents),
    vatCentsSnapshot:
      numberValue(row.vat_cents) ||
      numberValue(row.vat_cents_snapshot) ||
      numberValue(row.line_vat_cents),
    totalCentsSnapshot:
      numberValue(row.total_cents) ||
      numberValue(row.total_cents_snapshot) ||
      numberValue(row.line_total_cents),
    createdAt: stringValue(row.created_at),
  }));
  const invoices: Invoice[] = (raw.invoices ?? []).map((row) => {
    const snapshot = documentSnapshotFromRaw(
      row.snapshot_json,
      appState.data_dir,
    );
    const qrBill =
      snapshot?.qrBill ??
      storedQrBillFromRaw(
        invoiceQrBills.find(
          (item) => stringValue(item.invoice_id) === stringValue(row.id),
        ),
        stringValue(row.id),
      );
    return {
      id: stringValue(row.id),
      number: stringValue(row.number),
      clientId: stringValue(row.client_id),
      projectId: stringValue(row.project_id) || null,
      quoteId: stringValue(row.quote_id) || null,
      originalInvoiceId: stringValue(row.original_invoice_id) || null,
      title: stringValue(row.title),
      type:
        (
          {
            acompte: 'deposit',
            situation: 'progress',
            finale: 'final',
            avoir: 'credit_note',
          } as Record<string, Invoice['type']>
        )[stringValue(row.type)] ?? 'standard',
      issueDate: stringValue(row.issue_date),
      dueDate: stringValue(row.due_date),
      serviceDateFrom: stringValue(row.service_date_from),
      serviceDateTo: stringValue(row.service_date_to),
      currency: stringValue(row.currency) || 'CHF',
      status: invoiceStatusFromRaw(row.status),
      lines: invoiceItems
        .filter((item) => stringValue(item.invoice_id) === stringValue(row.id))
        .sort((a, b) => numberValue(a.position) - numberValue(b.position))
        .map(lineFromRaw),
      notes: stringValue(row.notes),
      terms: stringValue(row.terms),
      depositPercentageBp: numberValue(row.deposit_percentage_bp) || null,
      depositBasisLines: depositBasisLinesFromRaw(row.deposit_basis_json),
      createdAt: stringValue(row.created_at),
      snapshot,
      qrBill,
    };
  });
  const invoiceCorrectionWorkflows: InvoiceCorrectionWorkflow[] = (
    raw.invoice_correction_workflows ?? []
  ).map((row) => ({
    id: stringValue(row.id),
    originalInvoiceId: stringValue(row.original_invoice_id),
    creditNoteId: stringValue(row.credit_note_id),
    replacementInvoiceId: stringValue(row.replacement_invoice_id),
    reason: stringValue(row.reason),
    createdAt: stringValue(row.created_at),
  }));
  const employees: Employee[] = (raw.employees ?? []).map((row) => ({
    id: stringValue(row.id),
    employeeNumber: stringValue(row.employee_number),
    name: stringValue(row.name),
    role: stringValue(row.role),
    email: stringValue(row.email),
    phone: stringValue(row.phone),
    address: [
      stringValue(row.address_line1),
      stringValue(row.address_line2),
      [stringValue(row.postal_code), stringValue(row.city)]
        .filter(Boolean)
        .join(' '),
      stringValue(row.canton),
    ]
      .filter(Boolean)
      .join('\n'),
    addressLine1: stringValue(row.address_line1),
    addressLine2: stringValue(row.address_line2),
    postalCode: stringValue(row.postal_code),
    city: stringValue(row.city),
    canton: stringValue(row.canton),
    country: stringValue(row.country),
    birthDate: stringValue(row.birth_date),
    avsNumber: stringValue(row.social_security_number),
    employmentStart: stringValue(row.employment_start_date),
    employmentEnd: stringValue(row.employment_end_date),
    employmentContractKind: nullableString(
      row.employment_contract_kind,
    ) as Employee['employmentContractKind'],
    lppAssessmentYear:
      row.lpp_assessment_year === null || row.lpp_assessment_year === undefined
        ? null
        : numberValue(row.lpp_assessment_year),
    lppAnnualSalaryCents:
      row.lpp_annual_salary_cents === null ||
      row.lpp_annual_salary_cents === undefined
        ? null
        : numberValue(row.lpp_annual_salary_cents),
    lppExceptionCode: nullableString(
      row.lpp_exception_code,
    ) as Employee['lppExceptionCode'],
    lppExceptionEvidenceReference: stringValue(
      row.lpp_exception_evidence_reference,
    ),
    referenceAgeDate: stringValue(row.reference_age_date),
    avsAllowanceWaived:
      row.avs_allowance_waived === null ||
      row.avs_allowance_waived === undefined
        ? null
        : boolValue(row.avs_allowance_waived),
    ...employeeSmallSalaryFieldsFromRaw(row),
    employmentRate: numberValue(row.employment_rate),
    contractualWeeklyMinutes:
      row.contractual_weekly_minutes === null ||
      row.contractual_weekly_minutes === undefined
        ? null
        : numberValue(row.contractual_weekly_minutes),
    acOpeningYear:
      row.ac_opening_year === null || row.ac_opening_year === undefined
        ? null
        : numberValue(row.ac_opening_year),
    acOpeningBasisCents:
      row.ac_opening_basis_cents === null ||
      row.ac_opening_basis_cents === undefined
        ? null
        : numberValue(row.ac_opening_basis_cents),
    laaOpeningYear:
      row.laa_opening_year === null || row.laa_opening_year === undefined
        ? null
        : numberValue(row.laa_opening_year),
    laaOpeningBasisCents:
      row.laa_opening_basis_cents === null ||
      row.laa_opening_basis_cents === undefined
        ? null
        : numberValue(row.laa_opening_basis_cents),
    salaryMode:
      numberValue(row.monthly_salary_cents) > 0 ? 'monthly' : 'hourly',
    grossSalaryCents: numberValue(row.monthly_salary_cents),
    hourlyCostCents: numberValue(row.hourly_rate_cents),
    iban: stringValue(row.iban),
    active: stringValue(row.status) !== 'inactif',
    notes: stringValue(row.notes),
  }));
  const timeEntries: TimeEntry[] = (raw.time_entries ?? []).map((row) => ({
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    taskId: nullableString(row.task_id),
    employeeId: stringValue(row.employee_id),
    date: stringValue(row.date),
    minutes: numberValue(row.minutes),
    breakMinutes: numberValue(row.break_minutes),
    billable: boolValue(row.billable),
    billingRateCents: numberValue(row.billing_rate_cents),
    hourlyCostCents: numberValue(row.cost_rate_cents),
    note: stringValue(row.note),
    status:
      (
        { approuve: 'approved', verrouille: 'locked' } as Record<
          string,
          TimeEntry['status']
        >
      )[stringValue(row.status)] ?? 'entered',
    billingStatus:
      (
        { reserved: 'reserved', billed: 'billed' } as Record<
          string,
          TimeEntry['billingStatus']
        >
      )[stringValue(row.billing_status)] ?? 'unbilled',
    billingBatchId: nullableString(row.billing_batch_id),
    billingInvoiceId: nullableString(row.billing_invoice_id),
    billingInvoiceNumber: nullableString(row.billing_invoice_number),
    createdAt: stringValue(row.created_at),
  }));
  const timeBillingBatches: TimeBillingBatch[] = (
    raw.time_billing_batches ?? []
  ).map((row) => ({
    id: stringValue(row.id),
    requestId: stringValue(row.request_id),
    invoiceId: stringValue(row.invoice_id),
    projectId: stringValue(row.project_id),
    clientId: stringValue(row.client_id),
    vatBp: numberValue(row.vat_bp),
    createdAt: stringValue(row.created_at),
  }));
  const timeBillingEntries: TimeBillingEntry[] = (
    raw.time_billing_entries ?? []
  ).map((row) => ({
    id: stringValue(row.id),
    batchId: stringValue(row.batch_id),
    timeEntryId: stringValue(row.time_entry_id),
    invoiceItemId: stringValue(row.invoice_item_id),
    entryDate: stringValue(row.entry_date_snapshot),
    minutes: numberValue(row.minutes_snapshot),
    billingRateCents: numberValue(row.billing_rate_cents_snapshot),
    amountCents: numberValue(row.amount_cents_snapshot),
    employeeName: stringValue(row.employee_name_snapshot),
    note: stringValue(row.note_snapshot),
    createdAt: stringValue(row.created_at),
  }));
  const expenses: Expense[] = (raw.expenses ?? []).map((row) => ({
    ...purchaseCostFromRaw(row, 'vat_cents'),
    id: stringValue(row.id),
    projectId: stringValue(row.project_id) || null,
    supplierId: stringValue(row.supplier_id) || null,
    date: stringValue(row.date),
    dueDate: stringValue(row.due_date) || null,
    supplier: stringValue(row.supplier),
    category: stringValue(row.category),
    reference: stringValue(row.reference),
    netCents: numberValue(row.net_cents),
    vatCents: numberValue(row.vat_cents),
    totalCents: numberValue(row.total_cents),
    paymentStatus: expensePaymentStatusFromRaw(row.payment_status),
    paidAt: stringValue(row.paid_at) || null,
    reimbursable: boolValue(row.reimbursable),
    note: stringValue(row.note),
  }));
  const supplierOrders: SupplierOrder[] = (raw.supplier_orders ?? []).map(
    (row) => {
      const id = stringValue(row.id);
      const lines = supplierOrderLines
        .filter((line) => line.supplierOrderId === id)
        .sort((left, right) => left.position - right.position);
      const subtotalCents = numberValue(row.subtotal_cents);
      const vatCents = numberValue(row.vat_cents);
      return {
        id,
        supplierId: stringValue(row.supplier_id),
        projectId: nullableString(row.project_id),
        number: stringValue(row.number),
        title: stringValue(row.title) || 'Commande fournisseur',
        status: supplierOrderStatusFromRaw(row.status),
        orderDate: stringValue(row.order_date),
        currency: stringValue(row.currency) || 'CHF',
        subtotalCents,
        discountCents: numberValue(row.discount_cents),
        vatCents,
        totalCents:
          numberValue(row.total_cents) ||
          lines.reduce((total, line) => total + line.lineTotalCents, 0) ||
          subtotalCents + vatCents,
        notes: stringValue(row.notes),
        terms: stringValue(row.terms),
        confirmedAt: nullableString(row.confirmed_at),
        closedAt: nullableString(row.closed_at),
        cancelledAt: nullableString(row.cancelled_at),
        cancellationReason: stringValue(row.cancellation_reason),
        createdAt: stringValue(row.created_at),
        updatedAt: stringValue(row.updated_at),
        lines,
      };
    },
  );
  const supplierOrderCancellationLines: SupplierOrderCancellationLine[] = (
    raw.supplier_order_cancellation_lines ?? []
  ).map((row) => ({
    id: stringValue(row.id),
    requestId: stringValue(row.request_id),
    supplierOrderId: stringValue(row.supplier_order_id),
    supplierOrderLineId: stringValue(row.supplier_order_line_id),
    quantityMilli: numberValue(row.quantity_milli),
    reason: stringValue(row.reason),
    createdAt: stringValue(row.created_at),
  }));
  const supplierReceipts: SupplierReceipt[] = (raw.supplier_receipts ?? []).map(
    (row) => {
      const id = stringValue(row.id);
      return {
        id,
        supplierOrderId: stringValue(row.supplier_order_id),
        number: stringValue(row.number),
        status: supplierReceiptStatusFromRaw(row.status),
        receiptDate: stringValue(row.receipt_date),
        reference: stringValue(row.reference),
        notes: stringValue(row.notes),
        issuedAt: nullableString(row.issued_at),
        reversedAt: nullableString(row.reversed_at),
        reversalReason: stringValue(row.reversal_reason),
        createdAt: stringValue(row.created_at),
        updatedAt: stringValue(row.updated_at),
        lines: supplierReceiptLines
          .filter((line) => line.supplierReceiptId === id)
          .sort((left, right) => left.position - right.position),
      };
    },
  );
  const supplierInvoiceMatches: SupplierInvoiceMatch[] = (
    raw.supplier_invoice_matches ?? []
  ).map((row) => ({
    id: stringValue(row.id),
    requestId: stringValue(row.request_id),
    supplierInvoiceId: stringValue(row.supplier_invoice_id),
    supplierInvoiceItemId: stringValue(row.supplier_invoice_item_id),
    supplierOrderId: stringValue(row.supplier_order_id),
    supplierOrderLineId: stringValue(row.supplier_order_line_id),
    supplierReceiptLineId: nullableString(row.supplier_receipt_line_id),
    quantityMilli: numberValue(row.quantity_milli),
    netCents: numberValue(row.net_cents),
    vatCents: numberValue(row.vat_cents),
    totalCents: numberValue(row.total_cents),
    createdAt: stringValue(row.created_at),
  }));
  const supplierCreditNotes: SupplierCreditNote[] = (
    raw.supplier_credit_notes ?? []
  ).map((row) => {
    const id = stringValue(row.id);
    const allocations = supplierCreditAllocations.filter(
      (allocation) => allocation.supplierCreditNoteId === id,
    );
    return {
      id,
      supplierId: stringValue(row.supplier_id),
      number: stringValue(row.number),
      documentDate: stringValue(row.document_date),
      supplierName: stringValue(row.supplier_name),
      reference: stringValue(row.reference),
      currency: stringValue(row.currency) || 'CHF',
      status: stringValue(row.status) === 'validated' ? 'validated' : 'draft',
      netCents: numberValue(row.net_cents),
      vatCents: numberValue(row.vat_cents),
      totalCents: numberValue(row.total_cents),
      allocatedCents: allocations.reduce(
        (total, allocation) =>
          total +
          (allocation.eventType === 'reverse'
            ? -allocation.amountCents
            : allocation.amountCents),
        0,
      ),
      note: stringValue(row.note),
      validatedAt: nullableString(row.validated_at),
      validationJournalEntryId: nullableString(row.validation_journal_entry_id),
      items: supplierCreditNoteItems
        .filter((item) => item.supplierCreditNoteId === id)
        .sort((left, right) => left.position - right.position),
      allocations,
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
    };
  });
  const supplierExpenseReclassifications: SupplierExpenseReclassification[] = (
    raw.supplier_expense_reclassifications ?? []
  ).map((row) => {
    const id = stringValue(row.id);
    return {
      id,
      supplierInvoiceId: stringValue(row.supplier_invoice_id),
      requestId: stringValue(row.request_id),
      effectiveDate: stringValue(row.effective_date),
      reason: stringValue(row.reason),
      journalEntryId: stringValue(row.journal_entry_id),
      createdAt: stringValue(row.created_at),
      lines: supplierExpenseReclassificationLines.filter(
        (line) => line.reclassificationId === id,
      ),
    };
  });
  const supplierInvoices: SupplierInvoice[] = (raw.supplier_invoices ?? []).map(
    (row) => {
      const documentStatus: SupplierInvoice['documentStatus'] =
        stringValue(row.status) === 'validated' ? 'validated' : 'draft';
      const totalCents = numberValue(row.total_cents);
      const paidCents = Math.max(
        0,
        Math.min(totalCents, numberValue(row.paid_cents)),
      );
      const creditedCents = Math.max(
        0,
        Math.min(totalCents, numberValue(row.credited_cents)),
      );
      const balanceCents = Math.max(
        0,
        row.balance_cents === undefined
          ? totalCents - paidCents - creditedCents
          : numberValue(row.balance_cents),
      );
      const paymentStatus: SupplierInvoice['paymentStatus'] =
        documentStatus === 'draft'
          ? null
          : balanceCents === 0
            ? 'paid'
            : paidCents > 0
              ? 'partial'
              : 'pending';
      const matchStatusRaw = stringValue(row.match_status);
      const matchStatus: SupplierInvoice['matchStatus'] =
        matchStatusRaw === 'partial' ||
        matchStatusRaw === 'matched' ||
        matchStatusRaw === 'mismatch'
          ? matchStatusRaw
          : 'unmatched';
      const id = stringValue(row.id);
      return {
        id,
        supplierId: stringValue(row.supplier_id),
        projectId: stringValue(row.project_id) || null,
        documentDate: stringValue(row.document_date),
        dueDate: stringValue(row.due_date),
        supplierName: stringValue(row.supplier_name),
        reference: stringValue(row.reference),
        currency: 'CHF',
        documentStatus,
        paymentStatus,
        netCents: numberValue(row.net_cents),
        vatCents: numberValue(row.vat_cents),
        totalCents,
        paidCents,
        creditedCents,
        balanceCents,
        matchStatus,
        validatedAt: stringValue(row.validated_at) || null,
        validationJournalEntryId:
          stringValue(row.validation_journal_entry_id) || null,
        note: stringValue(row.note),
        lines: supplierInvoiceItems
          .filter((item) => item.supplierInvoiceId === id)
          .sort((left, right) => left.position - right.position),
        payments: supplierInvoicePayments
          .filter((payment) => payment.supplierInvoiceId === id)
          .sort(
            (left, right) =>
              left.date.localeCompare(right.date) ||
              left.createdAt.localeCompare(right.createdAt),
          ),
        attachments: attachmentsForSupplierInvoice(
          supplierInvoiceAttachments,
          id,
        ),
        createdAt: stringValue(row.created_at),
        updatedAt: stringValue(row.updated_at),
      };
    },
  );
  const payslips: Payslip[] = (raw.payslips ?? []).map((row) => ({
    id: stringValue(row.id),
    employeeId: stringValue(row.employee_id),
    period: stringValue(row.period),
    status:
      (
        {
          brouillon: 'draft',
          a_controler: 'incomplete',
          valide: 'validated',
          comptabilise: 'posted',
          paye: 'paid',
        } as Record<string, Payslip['status']>
      )[stringValue(row.status)] ?? 'incomplete',
    lines: payslipItems
      .filter((item) => stringValue(item.payslip_id) === stringValue(row.id))
      .sort((a, b) => numberValue(a.position) - numberValue(b.position))
      .map((item) => ({
        id: stringValue(item.id),
        label: stringValue(item.label),
        kind: payslipLineKindFromRaw(item.kind),
        amountCents: numberValue(item.amount_cents),
        postingAccountId: stringValue(item.posting_account_id),
        expenseAccountId: stringValue(item.expense_account_id),
      })),
    paymentDate: stringValue(row.payment_date),
    paymentReference: stringValue(row.payment_reference),
    paymentJournalEntryId: stringValue(row.payment_journal_entry_id),
    notes: stringValue(row.notes),
    createdAt: stringValue(row.created_at),
    snapshot: payslipSnapshotFromRaw(row.snapshot_json, appState.data_dir),
  }));
  const payrollImports = (raw.payroll_document_imports ?? []).map(
    payrollImportFromRaw,
  );
  const employeePayrollTemplates = (raw.employee_payroll_templates ?? []).map(
    employeePayrollTemplateFromRaw,
  );
  const payments: Payment[] = (raw.payments ?? []).map((row) => ({
    id: stringValue(row.id),
    invoiceId: stringValue(row.invoice_id),
    date: stringValue(row.date),
    amountCents: numberValue(row.amount_cents),
    method: stringValue(row.method),
    reference: stringValue(row.reference),
    journalEntryId: nullableString(row.journal_entry_id),
    journalEntryNumber: stringValue(row.journal_entry_number),
    journalSourceEvent: stringValue(row.journal_source_event),
    journalEntryIsActive:
      row.journal_entry_is_active === undefined ||
      row.journal_entry_is_active === null
        ? undefined
        : boolValue(row.journal_entry_is_active),
    journalReversalDepth:
      row.journal_reversal_depth === undefined ||
      row.journal_reversal_depth === null
        ? undefined
        : numberValue(row.journal_reversal_depth),
    journalEntrySemanticallyValid:
      row.journal_entry_semantically_valid === undefined ||
      row.journal_entry_semantically_valid === null
        ? undefined
        : boolValue(row.journal_entry_semantically_valid),
  }));
  const timer = raw.active_timer;
  return {
    schemaVersion: numberValue(raw.schema_version) || 20,
    attachments: (raw.attachments ?? []).map(attachmentFromRaw),
    onboardingCompleted: appState.onboarding_completed,
    activityProfileRequired: boolValue(appState.activity_profile_required),
    settings: settingsFromRaw(raw.settings, appState.data_dir),
    clients,
    catalogItems,
    stockMovements,
    suppliers,
    projects,
    projectMilestones,
    projectTasks,
    agendaEvents,
    quotes,
    salesOrders,
    recurrenceSchedules,
    recurrenceOccurrences,
    deliveryNotes,
    stockReservationEvents,
    stockAvailability,
    salesOrderInvoiceBatches,
    salesOrderInvoiceAllocations,
    invoices,
    invoiceCorrectionWorkflows,
    payments,
    employees,
    timeEntries,
    timeBillingBatches,
    timeBillingEntries,
    activeTimer: timer
      ? {
          projectId: stringValue(timer.project_id),
          taskId: nullableString(timer.task_id),
          employeeId: stringValue(timer.employee_id),
          startedAt: stringValue(timer.started_at),
          note: stringValue(timer.note),
          billable: boolValue(timer.billable),
          billingRateCents: numberValue(timer.billing_rate_cents),
          hourlyCostCents: numberValue(timer.cost_rate_cents),
        }
      : null,
    expenses,
    supplierOrders,
    supplierOrderCancellationLines,
    supplierReceipts,
    supplierInvoices,
    supplierInvoicePayments,
    supplierInvoiceMatches,
    supplierCreditNotes,
    supplierExpenseReclassifications,
    payslips,
    payrollImports,
    employeePayrollTemplates,
    accounts: (raw.accounts ?? []).map(accountFromRaw),
    accountingSettings: raw.accounting_settings
      ? accountingSettingsFromRaw(raw.accounting_settings)
      : null,
    backupStatus: backupStatusFromRaw(raw.backup_status),
  };
}

function emptyWorkspace(): Workspace {
  return {
    schemaVersion: 20,
    onboardingCompleted: false,
    activityProfileRequired: true,
    settings: null,
    clients: [],
    catalogItems: [],
    stockMovements: [],
    suppliers: [],
    projects: [],
    projectMilestones: [],
    projectTasks: [],
    agendaEvents: [],
    quotes: [],
    salesOrders: [],
    recurrenceSchedules: [],
    recurrenceOccurrences: [],
    deliveryNotes: [],
    stockReservationEvents: [],
    stockAvailability: [],
    salesOrderInvoiceBatches: [],
    salesOrderInvoiceAllocations: [],
    invoices: [],
    invoiceCorrectionWorkflows: [],
    payments: [],
    employees: [],
    timeEntries: [],
    timeBillingBatches: [],
    timeBillingEntries: [],
    activeTimer: null,
    expenses: [],
    supplierOrders: [],
    supplierOrderCancellationLines: [],
    supplierReceipts: [],
    supplierInvoices: [],
    supplierInvoicePayments: [],
    supplierInvoiceMatches: [],
    supplierCreditNotes: [],
    supplierExpenseReclassifications: [],
    payslips: [],
    payrollImports: [],
    employeePayrollTemplates: [],
    accounts: [],
    accountingSettings: null,
    backupStatus: {
      lastSuccessAt: null,
      lastPath: null,
      nextScheduledAt: null,
    },
  };
}

async function loadWorkspace(): Promise<Workspace> {
  const appState = appStateFromRaw(await invoke<RawRecord>('get_app_state'));
  if (!appState.onboarding_completed) return emptyWorkspace();
  return normalizeWorkspace(
    await invoke<RawWorkspace>('get_workspace'),
    appState,
  );
}

function backendExtra(settings: AppSettings): string {
  return JSON.stringify({
    organization: {
      website: settings.organization.website,
      address: {
        buildingNumber: settings.organization.address.buildingNumber ?? '',
      },
    },
    billing: {
      accountHolder: settings.billing.accountHolder,
      creditNotePrefix: settings.billing.creditNotePrefix,
      nextQuoteNumber: settings.billing.nextQuoteNumber,
      nextInvoiceNumber: settings.billing.nextInvoiceNumber,
      nextCreditNoteNumber: settings.billing.nextCreditNoteNumber,
      quoteValidityDays: settings.billing.quoteValidityDays,
      vatRatesBp: settings.billing.vatRatesBp,
      defaultFooter: settings.billing.defaultFooter,
      footerTemplates: settings.billing.footerTemplates,
    },
    work: settings.work,
    payroll: settings.payroll,
    backup: settings.backup,
    setupDeferred: settings.setupDeferred ?? {
      billing: false,
      work: false,
      backup: false,
    },
  });
}

function settingsToBackend(settings: AppSettings): RawRecord {
  const street = settings.organization.address.street.split('\n');
  return {
    company_name: settings.organization.legalName,
    legal_form: settings.organization.legalForm,
    owner_name: settings.organization.contactName,
    email: settings.organization.email,
    phone: settings.organization.phone,
    address_line1: street[0] ?? '',
    address_line2: street.slice(1).join(' '),
    postal_code: settings.organization.address.postalCode,
    city: settings.organization.address.city,
    canton: settings.organization.address.canton,
    country: settings.organization.address.country,
    uid_number: settings.organization.uidNumber,
    vat_number: settings.organization.vatNumber,
    vat_registered: settings.organization.vatRegistered,
    default_vat_bp: settings.billing.vatRatesBp[0] ?? 0,
    iban: settings.billing.iban,
    bank_name: settings.billing.accountHolder,
    currency: 'CHF',
    quote_prefix: settings.billing.quotePrefix,
    invoice_prefix: settings.billing.invoicePrefix,
    credit_note_prefix: settings.billing.creditNotePrefix,
    quote_start_number: settings.billing.nextQuoteNumber,
    invoice_start_number: settings.billing.nextInvoiceNumber,
    credit_note_start_number: settings.billing.nextCreditNoteNumber,
    payment_terms_days: settings.billing.paymentTermsDays,
    quote_validity_days: settings.billing.quoteValidityDays,
    default_hourly_rate_cents: 0,
    logo_path: settings.organization.logoPath ?? '',
    noga_section: settings.business.nogaSection,
    noga_division: settings.business.nogaDivision,
    activity_description: settings.business.activityDescription,
    noga_detailed_code: settings.business.nogaDetailedCode || null,
    extra_settings_json: backendExtra(settings),
  };
}

const entityToBackend: Record<EntityKind, string> = {
  clients: 'clients',
  catalogItems: 'catalog_items',
  suppliers: 'suppliers',
  projects: 'projects',
  quotes: 'quotes',
  invoices: 'invoices',
  employees: 'employees',
  timeEntries: 'time_entries',
  expenses: 'expenses',
  payslips: 'payslips',
};
export function archiveEntityMutation(
  entity: EntityKind,
  id: string,
  archivedAt = new Date().toISOString(),
) {
  const backendEntity = entityToBackend[entity];
  if (
    entity === 'clients' ||
    entity === 'catalogItems' ||
    entity === 'suppliers'
  ) {
    return {
      command: 'update_record' as const,
      args: { entity: backendEntity, id, data: { archived_at: archivedAt } },
    };
  }
  return {
    command: 'delete_record' as const,
    args: { entity: backendEntity, id },
  };
}

export function stockMovementMutation(
  movementType: StockMovementType,
  input: {
    requestId: string;
    catalogItemId: string;
    quantityMilli: number;
    reason: string;
    reference?: string;
    date?: string;
  },
) {
  const command =
    movementType === 'correction'
      ? 'record_stock_correction'
      : movementType === 'entry'
        ? 'record_stock_entry'
        : 'record_stock_exit';
  return {
    command,
    args: {
      input: {
        request_id: input.requestId,
        catalog_item_id: input.catalogItemId,
        ...(movementType === 'correction'
          ? { delta_quantity_milli: input.quantityMilli }
          : { quantity_milli: input.quantityMilli }),
        reason: input.reason.trim(),
        reference: input.reference?.trim() || null,
        date: input.date || null,
      },
    },
  };
}

export function createRecurrenceScheduleMutation(
  input: CreateRecurrenceScheduleInput,
) {
  if (
    !Number.isInteger(input.paymentTermsDays) ||
    input.paymentTermsDays < 0 ||
    input.paymentTermsDays > 365
  ) {
    throw new RangeError(
      'Le délai de paiement doit être un nombre entier compris entre 0 et 365 jours.',
    );
  }
  return {
    command: 'create_recurrence_schedule' as const,
    args: {
      input: {
        request_id: input.requestId.trim(),
        source_sales_order_id: input.sourceSalesOrderId.trim(),
        frequency: input.frequency,
        start_date: input.startDate.trim(),
        end_date: input.endDate?.trim() || null,
        payment_terms_days: input.paymentTermsDays,
      },
    },
  };
}

export function updateRecurrenceScheduleMutation(
  input: UpdateRecurrenceScheduleInput,
) {
  return {
    command: 'update_recurrence_schedule' as const,
    args: {
      input: {
        request_id: input.requestId.trim(),
        schedule_id: input.scheduleId.trim(),
        status: input.status,
        end_date: input.endDate?.trim() || null,
      },
    },
  };
}

export function generateRecurrenceOccurrencesMutation(
  input: GenerateRecurrenceOccurrencesInput,
) {
  return {
    command: 'generate_recurrence_occurrences' as const,
    args: {
      input: {
        request_id: input.requestId.trim(),
        schedule_id: input.scheduleId.trim(),
        through_date: input.throughDate.trim(),
      },
    },
  };
}
const statusToBackend: Record<string, string> = {
  planned: 'planifie',
  in_progress: 'en_cours',
  paused: 'en_pause',
  completed: 'termine',
  closed: 'cloture',
  draft: 'brouillon',
  issued: 'emis',
  accepted: 'accepte',
  refused: 'refuse',
  expired: 'expire',
  partially_paid: 'partiellement_payee',
  paid: 'payee',
  cancelled: 'annulee',
  entered: 'saisi',
  approved: 'approuve',
  locked: 'verrouille',
  incomplete: 'a_controler',
  validated: 'valide',
};
const snakeKey = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
export function toBackendData(data: Record<string, unknown>): RawRecord {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      snakeKey(key),
      key === 'status' && typeof value === 'string'
        ? (statusToBackend[value] ?? value)
        : value,
    ]),
  );
}

export function documentLineToBackend(
  line: DocumentLine,
  preserveId = false,
) {
  return {
    id: preserveId ? line.id : null,
    catalog_item_id: line.catalogItemId || null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unit_price_cents: line.unitPriceCents,
    discount_bp: line.discountBp ?? 0,
    vat_bp: line.vatRateBp,
  };
}

export function importCatalogItemsMutation(
  rows: CatalogImportRow[],
  conflictPolicy: 'update' | 'skip',
) {
  return {
    command: 'import_catalog_items' as const,
    args: {
      input: {
        conflict_policy: conflictPolicy,
        rows: rows.map((row) => ({
          row_number: row.rowNumber,
          sku: row.sku,
          name: row.name,
          description: row.description,
          unit: row.unit,
          purchase_cost_cents: row.purchaseCostCents,
          sales_price_cents: row.salesPriceCents,
          vat_bp: row.vatBp,
          kind: row.kind,
        })),
      },
    },
  };
}

export function convertQuoteMutation(
  quote: Pick<Quote, 'id' | 'title'>,
  depositPercentageBp: number | null = null,
) {
  if (
    depositPercentageBp !== null &&
    !validDepositPercentageBp(depositPercentageBp)
  ) {
    throw new RangeError(
      'Le pourcentage d’acompte doit être compris entre 0,01 et 100 %.',
    );
  }
  return {
    command: 'convert_quote_to_invoice' as const,
    args: {
      input: {
        quote_id: quote.id,
        title: quote.title,
        deposit_percentage_bp: depositPercentageBp,
      },
    },
  };
}
const createRecord = (entity: string, data: RawRecord) =>
  invoke<RawRecord>('create_record', { entity, data });

async function saveDocument(
  entity: 'quotes' | 'invoices',
  data: Record<string, unknown>,
  lines: DocumentLine[],
  existing?: Quote | Invoice,
): Promise<Workspace> {
  const previousLines = existing?.lines ?? [];
  const backendData = toBackendData(data);
  const depositBasisLines = data.depositBasisLines;
  delete backendData.deposit_basis_lines;
  if (depositBasisLines === null) {
    backendData.deposit_basis_json = null;
  } else if (Array.isArray(depositBasisLines)) {
    backendData.deposit_basis_json = depositBasisLines.map((line) => {
      const basisLine = line as DocumentLine;
      return {
        id: basisLine.id,
        catalog_item_id: basisLine.catalogItemId || null,
        description: basisLine.description,
        quantity: basisLine.quantity,
        unit: basisLine.unit,
        unit_price_cents: basisLine.unitPriceCents,
        discount_bp: basisLine.discountBp ?? 0,
        vat_bp: basisLine.vatRateBp,
      };
    });
  }
  await invoke('save_document_with_items', {
    input: {
      entity,
      id: existing?.id ?? null,
      data: backendData,
      items: lines.map((line) =>
        documentLineToBackend(
          line,
          previousLines.some((previous) => previous.id === line.id),
        ),
      ),
    },
  });
  return loadWorkspace();
}

async function chooseFile(
  options: OpenDialogOptions & { multiple?: false },
): Promise<string | null> {
  const dialog = await import('@tauri-apps/plugin-dialog');
  const selected = await dialog.open(options);
  return selected && !options.directory ? materializeMobileFile(selected) : selected;
}

async function chooseFiles(
  options: OpenDialogOptions & { multiple: true },
): Promise<string[]> {
  const dialog = await import('@tauri-apps/plugin-dialog');
  const result = await dialog.open(options);
  const files: string[] = [];
  for (const path of result ?? []) files.push(await materializeMobileFile(path));
  return files;
}

async function chooseSaveFile(
  options: SaveDialogOptions,
): Promise<string | null> {
  if (isMobileRuntime()) return invoke<string>('prepare_mobile_export', { name: options.defaultPath || 'document.pdf' });
  const dialog = await import('@tauri-apps/plugin-dialog');
  return dialog.save(options);
}

function payrollImportDraftToRaw(draft: PayrollImportDraft): RawRecord {
  const raw: RawRecord = {
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
    lines: draft.lines.map((line) => ({
      id: line.id,
      source_ref: line.sourceRef ?? '',
      label: line.label,
      kind: line.kind,
      amount_cents: line.amountCents,
      recurring: line.recurring,
      confidence_bp: line.confidenceBp,
    })),
    warnings: draft.warnings,
  };
  if (draft.review) {
    raw.review = {
      employee_id: draft.review.employeeId,
      employee_link_source: draft.review.employeeLinkSource,
      ai_identity_evidence: draft.review.aiIdentityEvidence
        ? {
            passes: draft.review.aiIdentityEvidence.passes,
            employee_number: draft.review.aiIdentityEvidence.employeeNumber,
            avs_number: draft.review.aiIdentityEvidence.avsNumber,
            birth_date: draft.review.aiIdentityEvidence.birthDate,
            iban: draft.review.aiIdentityEvidence.iban,
            conflicts: draft.review.aiIdentityEvidence.conflicts,
          }
        : null,
      ai_fields: draft.review.aiFields ?? [],
      ai_line_keys: draft.review.aiLineKeys ?? [],
      ai_warnings: draft.review.aiWarnings ?? [],
      manual_fields: draft.review.manualFields ?? [],
      manual_line_keys: draft.review.manualLineKeys ?? [],
      suppressed_line_keys: draft.review.suppressedLineKeys ?? [],
      confirmed_recurring_lines: (
        draft.review.confirmedRecurringLines ?? []
      ).map((line) => ({
        line_id: line.lineId ?? '',
        label: line.label,
        kind: line.kind,
        amount_cents: line.amountCents,
      })),
    };
  }
  return raw;
}

export function updatePayrollImportDraftMutation(
  id: string,
  draft: PayrollImportDraft,
  extractionEngine: string,
  engineVersion: string,
  confidenceBp: number,
  analysisManifest?: PayrollAnalysisManifest | null,
) {
  const input: RawRecord = {
    id,
    draft: payrollImportDraftToRaw(draft),
    extraction_engine: extractionEngine,
    engine_version: engineVersion || null,
    confidence_bp: confidenceBp,
  };
  // Une propriété absente maintient la compatibilité avec les anciens appels.
  // `null` reste réservé à un abandon intégral explicitement demandé.
  if (analysisManifest === null) {
    input.clear_analysis_manifest = true;
  } else if (analysisManifest) {
    input.analysis_manifest = payrollAnalysisManifestToRaw(analysisManifest);
  }
  return {
    command: 'update_payroll_import_draft' as const,
    args: { input },
  };
}

const nullableString = (value: unknown): string | null =>
  stringValue(value) || null;
const rawArray = (value: unknown, key?: string): RawRecord[] => {
  if (Array.isArray(value))
    return value.filter((item): item is RawRecord =>
      Boolean(item && typeof item === 'object'),
    );
  if (key && value && typeof value === 'object')
    return rawArray((value as RawRecord)[key]);
  return [];
};
const valueArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export function accountingFallbacksFromPostPayslip(
  value: unknown,
): AccountingFallback[] {
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
  return {
    id: stringValue(row.id),
    code: stringValue(row.code),
    name: stringValue(row.name),
    accountType: stringValue(row.account_type) as Account['accountType'],
    normalBalance: stringValue(row.normal_balance) as Account['normalBalance'],
    reportSection: stringValue(row.report_section) as Account['reportSection'],
    active: boolValue(row.active),
  };
}

function accountingSettingsFromRaw(
  row: RawRecord | null | undefined,
): AccountingSettings {
  return {
    enabled: boolValue(row?.enabled),
    arAccountId: stringValue(row?.ar_account_id),
    revenueAccountId: stringValue(row?.revenue_account_id),
    vatPayableAccountId: stringValue(row?.vat_payable_account_id),
    vatDeferredPayableAccountId: stringValue(
      row?.vat_deferred_payable_account_id,
    ),
    bankAccountId: stringValue(row?.bank_account_id),
    expenseAccountId: stringValue(row?.expense_account_id),
    vatReceivableAccountId: stringValue(row?.vat_receivable_account_id),
    wagesExpenseAccountId: stringValue(row?.wages_expense_account_id),
    wagesPayableAccountId: stringValue(row?.wages_payable_account_id),
    socialExpenseAccountId: stringValue(row?.social_expense_account_id),
    socialPayableAccountId: stringValue(row?.social_payable_account_id),
    supplierPayableAccountId: stringValue(row?.supplier_payable_account_id),
  };
}

function accountingContinuityFromRaw(
  row: RawRecord | null | undefined,
): AccountingContinuity {
  return {
    enabled: boolValue(row?.enabled),
    mappingReady: boolValue(row?.mapping_ready),
    starterAvailable: boolValue(row?.starter_available),
    journalEntryCount: numberValue(row?.journal_entry_count),
    missingInvoices: numberValue(row?.missing_invoices),
    missingPayments: numberValue(row?.missing_payments),
    missingExpenses: numberValue(row?.missing_expenses),
    missingSupplierInvoices: numberValue(row?.missing_supplier_invoices),
    missingSupplierPayments: numberValue(row?.missing_supplier_payments),
    missingPayslips: numberValue(row?.missing_payslips),
    missingPayslipPayments: numberValue(row?.missing_payslip_payments),
    undatedPayslipPayments: numberValue(row?.undated_payslip_payments),
    payslipPaymentLinksMissing: numberValue(row?.payslip_payment_links_missing),
    totalMissing: numberValue(row?.total_missing),
    closedHistoryRequiresOpening: numberValue(
      row?.closed_history_requires_opening,
    ),
    skippedCancelledInvoices: numberValue(row?.skipped_cancelled_invoices),
    cancelledInvoicePayments: numberValue(row?.cancelled_invoice_payments),
    reversedSources: numberValue(row?.reversed_sources),
    cancelledActivePostings: numberValue(row?.cancelled_active_postings),
    semanticPostingMismatches: numberValue(row?.semantic_posting_mismatches),
    totalAnomalies: numberValue(row?.total_anomalies),
  };
}

function accountingPeriodFromRaw(row: RawRecord): AccountingPeriod {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    dateFrom: stringValue(row.date_from),
    dateTo: stringValue(row.date_to),
    status: stringValue(row.status) as AccountingPeriod['status'],
    closedAt: stringValue(row.closed_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function fiduciaryReviewFromRaw(value: unknown): FiduciaryClosingReview {
  const row = recordValue(value);
  const checks = recordValue(row.checks);
  const summary = recordValue(row.summary);
  return {
    schema: 'elyko.fiduciary-pre-closing.v1',
    reviewId: stringValue(row.review_id),
    preparedAt: stringValue(row.prepared_at),
    period: accountingPeriodFromRaw(recordValue(row.period)),
    sourceSha256: stringValue(row.source_sha256),
    packageStatusIfExported: stringValue(
      row.package_status_if_exported,
    ) as FiduciaryClosingReview['packageStatusIfExported'],
    checks: {
      readyForFinal: boolValue(checks.ready_for_final),
      journalBalanced: boolValue(checks.journal_balanced),
      balanceSheetBalanced: boolValue(checks.balance_sheet_balanced),
      auditChainValid: boolValue(checks.audit_chain_valid),
      attachmentsTotal: numberValue(checks.attachments_total),
      attachmentsVerified: numberValue(checks.attachments_verified),
      attachmentIssues: rawArray(checks.attachment_issues).map((issue) => ({
        attachmentId: stringValue(issue.attachment_id),
        originalName: stringValue(issue.original_name),
        issue: stringValue(issue.issue),
      })),
      continuity: accountingContinuityFromRaw(recordValue(checks.continuity)),
    },
    summary: {
      journalEntries: numberValue(summary.journal_entries),
      journalLines: numberValue(summary.journal_lines),
      accountsWithActivity: numberValue(summary.accounts_with_activity),
      debitCents: numberValue(summary.debit_cents),
      creditCents: numberValue(summary.credit_cents),
      profitCents: numberValue(summary.profit_cents),
      assetsCents: numberValue(summary.assets_cents),
      liabilitiesCents: numberValue(summary.liabilities_cents),
      equityCents: numberValue(summary.equity_cents),
    },
    disclaimer: stringValue(row.disclaimer),
  };
}

const optionalNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function vatProfileFromRaw(value: unknown): VatProfile {
  const row = recordValue(value);
  return {
    id: stringValue(row.id),
    effectiveFrom: stringValue(row.effective_from),
    effectiveTo: nullableString(row.effective_to),
    reportingMethod: stringValue(row.reporting_method) as VatReportingMethod,
    formOfReporting: stringValue(row.form_of_reporting) as VatReportingBasis,
    periodicity: stringValue(row.periodicity) as VatReportingPeriodicity,
    grossOrNet: stringValue(row.gross_or_net) as VatProfile['grossOrNet'],
    tdfnActivityId: nullableString(row.tdfn_activity_id),
    tdfnRateBp: optionalNumber(row.tdfn_rate_bp),
    afcAuthorizationConfirmed: boolValue(row.afc_authorization_confirmed),
    notes: stringValue(row.notes),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function vatClassificationFromRaw(value: unknown): VatSourceClassification {
  const row = recordValue(value);
  return {
    id: stringValue(row.id),
    sourceType: stringValue(row.source_type) as VatSourceType,
    sourceId: stringValue(row.source_id),
    treatment: stringValue(row.treatment) as VatSourceTreatment,
    note: stringValue(row.note),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function vatAdjustmentFromRaw(value: unknown): VatAdjustment {
  const row = recordValue(value);
  return {
    sequence: numberValue(row.sequence),
    id: stringValue(row.id),
    adjustmentDate: stringValue(row.adjustment_date),
    category: stringValue(row.category) as VatAdjustmentCategory,
    amountCents: numberValue(row.amount_cents),
    taxRateBp: optionalNumber(row.tax_rate_bp),
    description: stringValue(row.description),
    evidenceReference: stringValue(row.evidence_reference),
    reversesAdjustmentId: nullableString(row.reverses_adjustment_id),
    createdBy: stringValue(row.created_by),
    createdAt: stringValue(row.created_at),
  };
}

function vatRateLineFromRaw(value: unknown) {
  const row = recordValue(value);
  const activityId = stringValue(row.activity_id);
  return {
    taxRateBp: numberValue(row.tax_rate_bp),
    turnoverCents: numberValue(row.turnover_cents),
    calculatedTaxCents: numberValue(row.calculated_tax_cents),
    ...(activityId ? { activityId } : {}),
  };
}

function supplierEmailInspectionFromRaw(
  row: RawRecord,
): SupplierEmailInspection {
  const confidence = stringValue(row.confidence);
  const optionalInteger = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  return {
    fileName: stringValue(row.file_name),
    fileSizeBytes: numberValue(row.file_size_bytes),
    sha256: stringValue(row.sha256),
    messageId: stringValue(row.message_id),
    subject: stringValue(row.subject),
    senderName: stringValue(row.sender_name),
    senderEmail: stringValue(row.sender_email),
    attachmentNames: Array.isArray(row.attachment_names)
      ? row.attachment_names.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    importableAttachments: Array.isArray(row.importable_attachments)
      ? row.importable_attachments.flatMap((value) => {
          const attachment = recordValue(value);
          const name = stringValue(attachment.name);
          const mimeType = stringValue(attachment.mime_type);
          const sizeBytes = numberValue(attachment.size_bytes);
          const sha256 = stringValue(attachment.sha256);
          return name && mimeType && sizeBytes > 0 && /^[0-9a-f]{64}$/i.test(sha256)
            ? [{ name, mimeType, sizeBytes, sha256 }]
            : [];
        })
      : [],
    invoiceSignal: boolValue(row.invoice_signal),
    confidence: ['low', 'medium', 'high'].includes(confidence)
      ? (confidence as SupplierEmailInspection['confidence'])
      : 'low',
    matchedSupplierId: nullableString(row.matched_supplier_id),
    duplicateInvoiceId: nullableString(row.duplicate_invoice_id),
    reference: stringValue(row.reference),
    documentDate: stringValue(row.document_date),
    dueDate: stringValue(row.due_date),
    currency: stringValue(row.currency),
    netCents: optionalInteger(row.net_cents),
    vatCents: optionalInteger(row.vat_cents),
    totalCents: optionalInteger(row.total_cents),
    issues: Array.isArray(row.issues)
      ? row.issues.filter((value): value is string => typeof value === 'string')
      : [],
    networkAccess: false,
    aiUsed: false,
  };
}

function vatPreviewFromRaw(value: unknown): VatReturnPreview {
  const row = recordValue(value);
  const turnover = recordValue(row.turnover_computation);
  const effective = row.effective_reporting_method
    ? recordValue(row.effective_reporting_method)
    : null;
  const simple = row.simple_tax_rate_method
    ? recordValue(row.simple_tax_rate_method)
    : null;
  const other = recordValue(row.other_flows_of_funds);
  return {
    standard: 'eCH-0217',
    standardVersion: '2.0.0',
    currency: 'CHF',
    profile: vatProfileFromRaw(row.profile),
    dateFrom: stringValue(row.date_from),
    dateTo: stringValue(row.date_to),
    submissionType: stringValue(row.submission_type) as VatSubmissionType,
    exportable: boolValue(row.exportable),
    blockingIssues: rawArray(row.blocking_issues).map((issue) => ({
      code: stringValue(issue.code),
      message: stringValue(issue.message),
      sourceType: nullableString(issue.source_type) as VatReturnPreview['blockingIssues'][number]['sourceType'],
      sourceId: nullableString(issue.source_id),
    })),
    warnings: Array.isArray(row.warnings)
      ? row.warnings.map(stringValue).filter(Boolean)
      : [],
    unclassifiedSources: rawArray(row.unclassified_sources).map((source) => ({
      sourceType: stringValue(source.source_type) as VatSourceType,
      sourceId: stringValue(source.source_id),
      parentId: stringValue(source.parent_id),
      occurrenceDate: stringValue(source.occurrence_date),
      description: stringValue(source.description),
      amountCents: numberValue(source.amount_cents),
      vatCents: numberValue(source.vat_cents),
      vatRateBp: optionalNumber(source.vat_rate_bp),
    })),
    classifiedSources: rawArray(row.classified_sources).map((source) => ({
      sourceType: stringValue(source.source_type) as VatSourceType,
      sourceId: stringValue(source.source_id), parentId: stringValue(source.parent_id),
      occurrenceDate: stringValue(source.occurrence_date), description: stringValue(source.description),
      amountCents: numberValue(source.amount_cents), vatCents: numberValue(source.vat_cents), vatRateBp: optionalNumber(source.vat_rate_bp),
      treatment: stringValue(source.treatment) as VatSourceTreatment, currency: stringValue(source.currency) || 'CHF',
    })),
    receivedAllocations: rawArray(row.received_allocations).map((allocation) => {
      const settlement = recordValue(allocation.settlement);
      return {
        sourceType: stringValue(allocation.source_type) as VatSourceType,
        sourceId: stringValue(allocation.source_id), parentId: stringValue(allocation.parent_id),
        description: stringValue(allocation.description), currency: stringValue(allocation.currency),
        paymentId: stringValue(allocation.payment_id), date: stringValue(allocation.date),
        grossCents: numberValue(allocation.gross_cents), netCents: numberValue(allocation.net_cents), vatCents: numberValue(allocation.vat_cents),
        ...(settlement.kind === 'credit_application' || settlement.kind === 'credit_reversal' ? { settlement: {
          kind: settlement.kind,
          counterpartId: stringValue(settlement.counterpart_id),
          counterpartReference: stringValue(settlement.counterpart_reference),
          reversesAllocationId: nullableString(settlement.reverses_allocation_id),
        } } : {}),
      };
    }),
    preClosingSources: rawArray(row.pre_closing_sources).map((source) => ({
      sourceType: stringValue(source.source_type) as VatSourceType,
      sourceId: stringValue(source.source_id), parentId: stringValue(source.parent_id),
      occurrenceDate: stringValue(source.occurrence_date), description: stringValue(source.description),
      amountCents: numberValue(source.amount_cents), vatCents: numberValue(source.vat_cents),
      vatRateBp: optionalNumber(source.vat_rate_bp), currency: stringValue(source.currency),
    })),
    sourceSha256: stringValue(row.source_sha256),
    turnoverComputation: {
      totalConsiderationCents: numberValue(turnover.total_consideration_cents),
      suppliesToForeignCountriesCents: numberValue(
        turnover.supplies_to_foreign_countries_cents,
      ),
      suppliesAbroadCents: numberValue(turnover.supplies_abroad_cents),
      transferNotificationProcedureCents: numberValue(
        turnover.transfer_notification_procedure_cents,
      ),
      suppliesExemptFromTaxCents: numberValue(
        turnover.supplies_exempt_from_tax_cents,
      ),
      reductionOfConsiderationCents: numberValue(
        turnover.reduction_of_consideration_cents,
      ),
      variousDeduction: turnover.various_deduction
        ? {
            amountCents: numberValue(
              recordValue(turnover.various_deduction).amount_cents,
            ),
            description: stringValue(
              recordValue(turnover.various_deduction).description,
            ),
          }
        : null,
      taxableTurnoverCents: numberValue(turnover.taxable_turnover_cents),
    },
    effectiveReportingMethod: effective
      ? {
          grossOrNet: stringValue(effective.gross_or_net) as 'net' | 'gross',
          grossOrNetCode: numberValue(effective.gross_or_net_code),
          optedCents: numberValue(effective.opted_cents),
          suppliesPerTaxRate: rawArray(effective.supplies_per_tax_rate).map(
            vatRateLineFromRaw,
          ),
          acquisitionTax: rawArray(effective.acquisition_tax).map(
            vatRateLineFromRaw,
          ),
          inputTaxMaterialAndServicesCents: numberValue(
            effective.input_tax_material_and_services_cents,
          ),
          inputTaxInvestmentsCents: numberValue(
            effective.input_tax_investments_cents,
          ),
          subsequentInputTaxDeductionCents: numberValue(
            effective.subsequent_input_tax_deduction_cents,
          ),
          inputTaxCorrectionsCents: numberValue(
            effective.input_tax_corrections_cents,
          ),
          inputTaxReductionsCents: numberValue(
            effective.input_tax_reductions_cents,
          ),
          outputTaxCents: numberValue(effective.output_tax_cents),
          acquisitionTaxCents: numberValue(effective.acquisition_tax_cents),
        }
      : null,
    simpleTaxRateMethod: simple
      ? {
          suppliesPerTaxRate: rawArray(simple.supplies_per_tax_rate).map(
            vatRateLineFromRaw,
          ),
          acquisitionTax: rawArray(simple.acquisition_tax).map(
            vatRateLineFromRaw,
          ),
          inputTaxCorrectionsCents: numberValue(
            simple.input_tax_corrections_cents,
          ),
          outputTaxCents: numberValue(simple.output_tax_cents),
          acquisitionTaxCents: numberValue(simple.acquisition_tax_cents),
        }
      : null,
    payableTaxCents: numberValue(row.payable_tax_cents),
    payableCode: stringValue(row.payable_code) as '500' | '510',
    otherFlowsOfFunds: {
      subsidiesCents: numberValue(other.subsidies_cents),
      donationsCents: numberValue(other.donations_cents),
    },
    sourceCount: numberValue(row.source_count),
    adjustmentCount: numberValue(row.adjustment_count),
    transmissionWording: stringValue(row.transmission_wording),
  };
}

function vatExportFromRaw(value: unknown): VatReturnExport {
  const row = recordValue(value);
  return {
    sequence: numberValue(row.sequence),
    id: stringValue(row.id),
    profileId: stringValue(row.profile_id),
    dateFrom: stringValue(row.date_from),
    dateTo: stringValue(row.date_to),
    submissionType: stringValue(row.submission_type) as VatSubmissionType,
    sourceSha256: stringValue(row.source_sha256),
    payload: vatPreviewFromRaw(row.payload),
    xmlSha256: stringValue(row.xml_sha256),
    fileName: stringValue(row.file_name),
    filePath: stringValue(row.file_path),
    createdAt: stringValue(row.created_at),
    transmissionStatus: 'not_transmitted',
    transmissionWording: stringValue(row.transmission_wording),
  };
}

function accountingConfigurationFromRaw(
  value: unknown,
): AccountingConfigurationResult {
  const row = recordValue(value);
  const synchronization = recordValue(row.synchronization);
  return {
    settings: accountingSettingsFromRaw(recordValue(row.settings)),
    synchronization: {
      createdTotal: numberValue(synchronization.created_total),
      createdInvoices: numberValue(synchronization.created_invoices),
      createdPayments: numberValue(synchronization.created_payments),
      createdExpenses: numberValue(synchronization.created_expenses),
      createdPayslips: numberValue(synchronization.created_payslips),
      createdPayslipPayments: numberValue(
        synchronization.created_payslip_payments,
      ),
      skippedClosedHistory: numberValue(synchronization.skipped_closed_history),
      requiresOpeningBalanceReview: boolValue(
        synchronization.requires_opening_balance_review,
      ),
      remaining: accountingContinuityFromRaw(
        recordValue(synchronization.remaining),
      ),
    },
  };
}

function journalEntryFromRaw(row: RawRecord): JournalEntry {
  return {
    id: stringValue(row.id),
    number: stringValue(row.number),
    entryDate: stringValue(row.entry_date),
    description: stringValue(row.description),
    sourceType: stringValue(row.source_type),
    sourceId: stringValue(row.source_id),
    sourceEvent: stringValue(row.source_event),
    status: 'posted',
    reversalOf: nullableString(row.reversal_of),
    hasReversal: boolValue(row.has_reversal),
    ...(['restore_expense','blocked_expense'].includes(String(row.reversal_action)) ? { reversalAction: row.reversal_action as JournalEntry['reversalAction'] } : {}),
  };
}

function journalLineFromRaw(row: RawRecord): JournalLine {
  const line: JournalLine = {
    id: stringValue(row.id),
    journalEntryId: stringValue(row.journal_entry_id),
    accountId: stringValue(row.account_id),
    accountCode: stringValue(row.account_code),
    accountName: stringValue(row.account_name),
    entryNumber: stringValue(row.entry_number),
    entryDate: stringValue(row.entry_date),
    debitCents: numberValue(row.debit_cents),
    creditCents: numberValue(row.credit_cents),
    currency: stringValue(row.currency),
    memo: stringValue(row.memo),
    projectId: nullableString(row.project_id),
    clientId: nullableString(row.client_id),
    employeeId: nullableString(row.employee_id),
  };
  if (row.running_net_debit_cents !== undefined) {
    line.runningNetDebitCents = numberValue(row.running_net_debit_cents);
    line.runningDebitBalanceCents = numberValue(
      row.running_debit_balance_cents,
    );
    line.runningCreditBalanceCents = numberValue(
      row.running_credit_balance_cents,
    );
  }
  return line;
}

function statementRowFromRaw(row: RawRecord): StatementRow {
  return {
    id: stringValue(row.id),
    code: stringValue(row.code),
    name: stringValue(row.name),
    accountType: stringValue(row.account_type) as StatementRow['accountType'],
    normalBalance: stringValue(
      row.normal_balance,
    ) as StatementRow['normalBalance'],
    reportSection: stringValue(
      row.report_section,
    ) as StatementRow['reportSection'],
    debitCents: numberValue(row.debit_cents),
    creditCents: numberValue(row.credit_cents),
    amountCents: numberValue(row.amount_cents),
    previousDebitCents: numberValue(row.previous_debit_cents),
    previousCreditCents: numberValue(row.previous_credit_cents),
    previousAmountCents: numberValue(row.previous_amount_cents),
  };
}

function statementScopeFromRaw(value: unknown): StatementScope {
  const row = recordValue(value);
  return {
    dateFrom: stringValue(row.date_from),
    dateTo: stringValue(row.date_to),
    previousDateFrom: stringValue(row.previous_date_from),
    previousDateTo: stringValue(row.previous_date_to),
    comparisonLabel: stringValue(row.comparison_label),
    comparisonSource: stringValue(
      row.comparison_source,
    ) as StatementScope['comparisonSource'],
    previousHasActivity: boolValue(row.previous_has_activity),
  };
}

function reportCurrencyFromRaw(value: unknown): ReportCurrency {
  const row = recordValue(value);
  return {
    baseCurrency: stringValue(row.base_currency),
    currencies: Array.isArray(row.currencies)
      ? row.currencies.map(stringValue).filter(Boolean)
      : [],
    singleCurrency: boolValue(row.single_currency),
    exchangeRatesApplied: boolValue(row.exchange_rates_applied),
  };
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as RawRecord).map(([key, amount]) => [
      key,
      numberValue(amount),
    ]),
  );
}

export function reminderTemplateFromRaw(row: RawRecord): ReminderTemplate {
  return {
    id: stringValue(row.id),
    level: numberValue(row.level),
    name: stringValue(row.name),
    subject: stringValue(row.subject),
    body: stringValue(row.body),
    daysAfterDue: numberValue(row.days_after_due),
    paymentDeadlineDays: numberValue(row.payment_deadline_days) || 10,
    active: boolValue(row.active),
  };
}

export function reminderFromRaw(row: RawRecord): Reminder {
  return {
    id: stringValue(row.id),
    invoiceId: stringValue(row.invoice_id),
    templateId: nullableString(row.template_id),
    level: numberValue(row.level),
    scheduledDate: stringValue(row.scheduled_date),
    status: stringValue(row.status) as ReminderStatus,
    subject: stringValue(row.subject),
    body: stringValue(row.body),
    notes: stringValue(row.notes),
    invoiceNumber: stringValue(row.invoice_number),
    invoiceTitle: stringValue(row.invoice_title),
    dueDate: stringValue(row.due_date),
    clientName: stringValue(row.client_name),
    currency: stringValue(row.currency) || 'CHF',
    invoiceTotalCents: numberValue(row.invoice_total_cents),
    balanceCents: numberValue(row.balance_cents),
    paymentDeadlineDays: numberValue(row.payment_deadline_days) || 10,
    liveBalanceCents:
      row.live_balance_cents === null || row.live_balance_cents === undefined
        ? null
        : numberValue(row.live_balance_cents),
    snapshotStale: boolValue(row.snapshot_stale),
    clientEmail: stringValue(row.client_email),
    clientPhone: stringValue(row.client_phone),
    clientAddressLine1: stringValue(row.client_address_line1),
    clientAddressLine2: stringValue(row.client_address_line2),
    clientPostalCode: stringValue(row.client_postal_code),
    clientCity: stringValue(row.client_city),
    clientCountry: stringValue(row.client_country),
    lastDeliveryAction: stringValue(row.last_delivery_action),
    lastDeliveryAt: stringValue(row.last_delivery_at),
  };
}

function reminderPartyFromRaw(value: unknown): ReminderParty {
  const row = recordValue(value);
  return {
    name: stringValue(row.name),
    addressLine1: stringValue(row.address_line1),
    addressLine2: stringValue(row.address_line2),
    postalCode: stringValue(row.postal_code),
    city: stringValue(row.city),
    canton: stringValue(row.canton),
    country: stringValue(row.country),
  };
}

function reminderSenderFromRaw(value: unknown): ReminderSender {
  const row = recordValue(value);
  return {
    ...reminderPartyFromRaw(row),
    company: stringValue(row.company),
    legalForm: stringValue(row.legal_form),
    owner: stringValue(row.owner),
    email: stringValue(row.email),
    phone: stringValue(row.phone),
    uidNumber: stringValue(row.uid_number),
    logoPath: stringValue(row.logo_path),
  };
}

export function reminderPreviewFromRaw(value: unknown): ReminderPreview {
  const row = recordValue(value);
  return {
    reminderId: stringValue(row.reminder_id),
    invoiceId: stringValue(row.invoice_id),
    invoiceNumber: stringValue(row.invoice_number),
    level: numberValue(row.level),
    dueDate: stringValue(row.due_date),
    scheduledDate: stringValue(row.scheduled_date),
    preparedOn: stringValue(row.prepared_on),
    paymentDeadlineDate: stringValue(row.payment_deadline_date),
    paymentDeadlineDays: numberValue(row.payment_deadline_days),
    currency: stringValue(row.currency) || 'CHF',
    snapshotBalanceCents: numberValue(row.snapshot_balance_cents),
    currentBalanceCents: numberValue(row.current_balance_cents),
    snapshotStale: boolValue(row.snapshot_stale),
    templateReviewRequired: boolValue(row.template_review_required),
    recipientEmail: stringValue(row.recipient_email),
    recipientPhone: stringValue(row.recipient_phone),
    client: reminderPartyFromRaw(row.client),
    sender: reminderSenderFromRaw(row.sender),
    subject: stringValue(row.subject),
    body: stringValue(row.body),
    smsBody: stringValue(row.sms_body),
    previewSha256: stringValue(row.preview_sha256),
  };
}

export function reminderScanResultFromRaw(value: unknown): ReminderScanResult {
  const row = recordValue(value);
  return {
    asOf: stringValue(row.as_of),
    enabled: boolValue(row.enabled),
    created: rawArray(row.created).map(reminderFromRaw),
    cancelled: valueArray(row.cancelled).map(stringValue).filter(Boolean),
    review: rawArray(row.review).map((item) => ({
      invoiceId: stringValue(item.invoice_id),
      reminderId: stringValue(item.reminder_id),
      reason: stringValue(item.reason),
    })),
    idempotent: boolValue(row.idempotent),
  };
}

export function reminderActionResultFromRaw(
  value: unknown,
): ReminderActionResult {
  const row = recordValue(value);
  const delivery = recordValue(row.delivery);
  return {
    blocked: boolValue(row.blocked),
    reason: stringValue(row.reason),
    reminder: row.reminder ? reminderFromRaw(recordValue(row.reminder)) : null,
    deliveryId: stringValue(delivery.id),
    idempotent: boolValue(row.idempotent),
  };
}

export function contributionFromRaw(
  row: RawRecord,
): PayrollContributionDefinition {
  return {
    id: stringValue(row.id) || stringValue(row.definition_id),
    code: stringValue(row.code),
    label: stringValue(row.label),
    category: stringValue(
      row.category,
    ) as PayrollContributionDefinition['category'],
    side: stringValue(row.side) as PayrollContributionDefinition['side'],
    calculationKind: stringValue(
      row.calculation_kind,
    ) as PayrollContributionDefinition['calculationKind'],
    rateBp:
      row.rate_bp === null || row.rate_bp === undefined
        ? null
        : numberValue(row.rate_bp),
    fixedAmountCents:
      row.fixed_amount_cents === null || row.fixed_amount_cents === undefined
        ? null
        : numberValue(row.fixed_amount_cents),
    annualCeilingCents:
      row.annual_ceiling_cents === null ||
      row.annual_ceiling_cents === undefined
        ? null
        : numberValue(row.annual_ceiling_cents),
    basisKind: stringValue(
      row.basis_kind,
    ) as PayrollContributionDefinition['basisKind'],
    lppComponent: nullableString(
      row.lpp_component,
    ) as PayrollContributionDefinition['lppComponent'],
    lppEmployeeId: nullableString(row.lpp_employee_id),
    source: stringValue(row.source),
    effectiveFrom: stringValue(row.effective_from),
    effectiveTo: stringValue(row.effective_to),
    active: boolValue(row.active),
    liabilityAccountId: stringValue(row.liability_account_id),
    expenseAccountId: stringValue(row.expense_account_id),
  };
}

export function payrollContributionDefinitionToRaw(
  input: Omit<PayrollContributionDefinition, 'id'> & { id?: string },
): RawRecord {
  return {
    id: input.id || null,
    code: input.code,
    label: input.label,
    category: input.category,
    side: input.side,
    calculation_kind: input.calculationKind,
    rate_bp: input.calculationKind === 'rate' ? input.rateBp : null,
    fixed_amount_cents:
      input.calculationKind === 'fixed' ? input.fixedAmountCents : null,
    annual_ceiling_cents: input.annualCeilingCents,
    basis_kind: input.basisKind,
    lpp_component: input.lppComponent,
    lpp_employee_id: input.lppEmployeeId,
    source: input.source,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo || null,
    active: input.active,
    liability_account_id: input.liabilityAccountId || null,
    expense_account_id: input.expenseAccountId || null,
  };
}

export function payrollSmallSalaryAssessmentFromRaw(
  value: unknown,
): PayrollSmallSalaryCalculationAssessment | null {
  if (value === null) return null;
  const invalid = (field: string, detail: string): never => {
    throw new Error(
      `Contrat de calcul des petits salaires invalide (${field}) : ${detail}`,
    );
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid(
      'small_salary_assessment',
      'un objet complet ou null était attendu.',
    );
  const row = value as RawRecord;
  const integer = (field: string, options?: { min?: number; max?: number }) => {
    const raw = row[field];
    if (!Number.isSafeInteger(raw))
      return invalid(field, 'un entier sûr est obligatoire.');
    const parsed = raw as number;
    if (options?.min !== undefined && parsed < options.min)
      invalid(field, `la valeur doit être au moins ${options.min}.`);
    if (options?.max !== undefined && parsed > options.max)
      invalid(field, `la valeur doit être au plus ${options.max}.`);
    return parsed;
  };
  const text = (field: string, maxLength?: number) => {
    const raw = row[field];
    if (typeof raw !== 'string' || raw.trim() === '')
      return invalid(field, 'un texte non vide est obligatoire.');
    if (maxLength !== undefined && raw.trim().length > maxLength)
      invalid(field, `le texte est limité à ${maxLength} caractères.`);
    return raw.trim();
  };
  const boolean = (field: string) => {
    const raw = row[field];
    if (typeof raw !== 'boolean')
      return invalid(field, 'un booléen explicite est obligatoire.');
    return raw;
  };
  const assessmentYear = integer('assessment_year', { min: 1900, max: 9999 });
  const sector = text('sector');
  if (
    sector !== 'ordinary' &&
    sector !== 'private_household' &&
    sector !== 'arts_culture'
  )
    return invalid(
      'sector',
      'ordinary, private_household ou arts_culture était attendu.',
    );
  const decisionDate = text('decision_date', 10);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(decisionDate);
  if (!dateMatch)
    return invalid('decision_date', 'une date AAAA-MM-JJ est obligatoire.');
  const decisionYear = Number(dateMatch[1]);
  const decisionMonth = Number(dateMatch[2]);
  const decisionDay = Number(dateMatch[3]);
  const parsedDate = new Date(
    Date.UTC(decisionYear, decisionMonth - 1, decisionDay),
  );
  if (
    parsedDate.getUTCFullYear() !== decisionYear ||
    parsedDate.getUTCMonth() !== decisionMonth - 1 ||
    parsedDate.getUTCDate() !== decisionDay ||
    decisionYear !== assessmentYear
  )
    invalid(
      'decision_date',
      'la date doit être réelle et appartenir à l’année d’évaluation.',
    );
  const openingGrossCents = integer('opening_gross_cents', { min: 0 });
  const openingContributedBasisCents = integer(
    'opening_contributed_basis_cents',
    { min: 0 },
  );
  const priorGrossCents = integer('prior_gross_cents', { min: 0 });
  const priorContributedBasisCents = integer('prior_contributed_basis_cents', {
    min: 0,
  });
  const currentGrossCents = integer('current_gross_cents', { min: 0 });
  const cumulativeGrossCents = integer('cumulative_gross_cents', { min: 0 });
  const statutoryContributionBasisCents = integer(
    'statutory_contribution_basis_cents',
    { min: 0 },
  );
  const statutoryCatchupBasisCents = integer('statutory_catchup_basis_cents', {
    min: 0,
  });
  const expectedCumulative =
    openingGrossCents + priorGrossCents + currentGrossCents;
  if (
    !Number.isSafeInteger(expectedCumulative) ||
    cumulativeGrossCents !== expectedCumulative
  )
    invalid(
      'cumulative_gross_cents',
      'le cumul ne correspond pas à ouverture + antérieur + période courante.',
    );
  if (openingContributedBasisCents > openingGrossCents)
    invalid(
      'opening_contributed_basis_cents',
      'la base cotisée dépasse le brut d’ouverture.',
    );
  if (statutoryCatchupBasisCents > statutoryContributionBasisCents)
    invalid(
      'statutory_catchup_basis_cents',
      'le rattrapage dépasse l’assiette totale cotisée.',
    );
  const contributionsDue = boolean('contributions_due');
  if (
    !contributionsDue &&
    (statutoryContributionBasisCents !== 0 || statutoryCatchupBasisCents !== 0)
  )
    invalid(
      'statutory_contribution_basis_cents',
      'une décision sans cotisation doit avoir deux assiettes à zéro.',
    );
  const reasonCode = text('reason_code');
  const supportedReasons = new Set([
    'ordinary_minor_salary_exempt',
    'ordinary_threshold_exceeded',
    'employee_requested_contributions',
    'private_household_youth_minor_salary_exempt',
    'private_household_mandatory',
    'arts_culture_mandatory',
  ]);
  if (!supportedReasons.has(reasonCode))
    invalid('reason_code', `motif moteur inconnu « ${reasonCode} ».`);
  return {
    assessmentYear,
    sector,
    employeeRequestedContributions: boolean('employee_requested_contributions'),
    decisionDate,
    thresholdCents: integer('threshold_cents', { min: 0 }),
    openingGrossCents,
    openingContributedBasisCents,
    priorGrossCents,
    priorContributedBasisCents,
    currentGrossCents,
    cumulativeGrossCents,
    contributionsDue,
    statutoryContributionBasisCents,
    statutoryCatchupBasisCents,
    reasonCode,
    evidenceReference: text('evidence_reference', 500),
  };
}

export function payslipContributionFromRaw(
  row: RawRecord,
): PayslipContributionSnapshot {
  return {
    id: stringValue(row.id),
    payslipId: stringValue(row.payslip_id),
    definitionId: stringValue(row.definition_id),
    payslipItemId: stringValue(row.payslip_item_id),
    label: stringValue(row.label),
    category: stringValue(
      row.category,
    ) as PayslipContributionSnapshot['category'],
    side: stringValue(row.side) as PayslipContributionSnapshot['side'],
    calculationKind: stringValue(
      row.calculation_kind,
    ) as PayslipContributionSnapshot['calculationKind'],
    basisKind: stringValue(
      row.basis_kind,
    ) as PayslipContributionSnapshot['basisKind'],
    basisCents: numberValue(row.basis_cents),
    yearToDateBasisCents:
      row.year_to_date_basis_cents === null ||
      row.year_to_date_basis_cents === undefined
        ? null
        : numberValue(row.year_to_date_basis_cents),
    rateBp:
      row.rate_bp === null || row.rate_bp === undefined
        ? null
        : numberValue(row.rate_bp),
    fixedAmountCents:
      row.fixed_amount_cents === null || row.fixed_amount_cents === undefined
        ? null
        : numberValue(row.fixed_amount_cents),
    annualCeilingCents:
      row.annual_ceiling_cents === null ||
      row.annual_ceiling_cents === undefined
        ? null
        : numberValue(row.annual_ceiling_cents),
    amountCents: numberValue(row.amount_cents),
    lppComponent: nullableString(
      row.lpp_component,
    ) as PayslipContributionSnapshot['lppComponent'],
    lppEmployeeId: nullableString(row.lpp_employee_id),
    source: stringValue(row.source),
    effectiveFrom: stringValue(row.effective_from),
    effectiveTo: stringValue(row.effective_to),
    liabilityAccountId: stringValue(row.liability_account_id),
    expenseAccountId: stringValue(row.expense_account_id),
    createdAt: stringValue(row.created_at),
  };
}

function frozenEmployeeFromRaw(row: RawRecord): FrozenEmployee {
  return {
    id: stringValue(row.id),
    employeeNumber: stringValue(row.employee_number),
    name: stringValue(row.name),
    role: stringValue(row.role),
    address: [
      stringValue(row.address_line1),
      stringValue(row.address_line2),
      [stringValue(row.postal_code), stringValue(row.city)]
        .filter(Boolean)
        .join(' '),
      stringValue(row.canton),
      stringValue(row.country),
    ]
      .filter(Boolean)
      .join('\n'),
    avsNumber: stringValue(row.social_security_number),
    iban: stringValue(row.iban),
    employmentRate: numberValue(row.employment_rate),
    employmentContractKind: nullableString(
      row.employment_contract_kind,
    ) as FrozenEmployee['employmentContractKind'],
    lppAssessmentYear:
      row.lpp_assessment_year === null || row.lpp_assessment_year === undefined
        ? null
        : numberValue(row.lpp_assessment_year),
    lppAnnualSalaryCents:
      row.lpp_annual_salary_cents === null ||
      row.lpp_annual_salary_cents === undefined
        ? null
        : numberValue(row.lpp_annual_salary_cents),
    lppExceptionCode: nullableString(
      row.lpp_exception_code,
    ) as FrozenEmployee['lppExceptionCode'],
    lppExceptionEvidenceReference: stringValue(
      row.lpp_exception_evidence_reference,
    ),
  };
}

function payslipSnapshotFromRaw(
  value: unknown,
  dataDir = '',
): FrozenPayslipSnapshot | null {
  const root = parsedSnapshot(value);
  if (!root || stringValue(root.schema) !== 'helvichantier.payslip_snapshot.v1')
    return null;
  const payslip = recordValue(root.payslip);
  const period = stringValue(payslip.period);
  const paymentDate = stringValue(payslip.payment_date);
  return {
    capturedAt: stringValue(root.captured_at),
    contributionDate:
      stringValue(root.contribution_date) ||
      paymentDate ||
      (period ? `${period}-01` : ''),
    issuer: frozenIssuerFromRaw(recordValue(root.issuer), dataDir),
    employee: frozenEmployeeFromRaw(recordValue(root.employee)),
    period,
    paymentDate,
    notes: stringValue(payslip.notes),
    items: rawArray(root.items).map((item) => ({
      id: stringValue(item.id),
      label: stringValue(item.label),
      kind: payslipLineKindFromRaw(item.kind),
      amountCents: numberValue(item.amount_cents),
      postingAccountId: stringValue(item.posting_account_id),
      expenseAccountId: stringValue(item.expense_account_id),
    })),
    contributions: rawArray(root.contributions).map(payslipContributionFromRaw),
  };
}

function qrInputToRaw(input: SwissQrBillInput): RawRecord {
  const party = (value: SwissQrBillInput['creditor']) => ({
    name: value.name,
    street: value.street,
    building_number: value.buildingNumber,
    postal_code: value.postalCode,
    city: value.city,
    country: value.country,
  });
  return {
    iban: input.iban,
    creditor: party(input.creditor),
    amount_cents: input.amountCents,
    currency: input.currency,
    debtor: input.debtor ? party(input.debtor) : null,
    reference_type: input.referenceType,
    reference: input.reference,
    unstructured_message: input.unstructuredMessage,
    bill_information: input.billInformation,
    alternative_procedures: input.alternativeProcedures,
  };
}

function qrInputFromRaw(row: RawRecord): SwissQrBillInput {
  const party = (value: unknown) => {
    const item = value && typeof value === 'object' ? (value as RawRecord) : {};
    return {
      name: stringValue(item.name),
      street: stringValue(item.street),
      buildingNumber: stringValue(item.building_number),
      postalCode: stringValue(item.postal_code),
      city: stringValue(item.city),
      country: stringValue(item.country),
    };
  };
  return {
    iban: stringValue(row.iban),
    creditor: party(row.creditor),
    amountCents:
      row.amount_cents === null || row.amount_cents === undefined
        ? undefined
        : numberValue(row.amount_cents),
    currency: stringValue(row.currency) as 'CHF' | 'EUR',
    debtor: row.debtor ? party(row.debtor) : undefined,
    referenceType: stringValue(
      row.reference_type,
    ) as SwissQrBillInput['referenceType'],
    reference: stringValue(row.reference),
    unstructuredMessage: stringValue(row.unstructured_message),
    billInformation: stringValue(row.bill_information),
    alternativeProcedures: Array.isArray(row.alternative_procedures)
      ? row.alternative_procedures.map(stringValue)
      : [],
  };
}

const periodFilterToRaw = (filter: PeriodFilter): RawRecord => ({
  date_from: filter.dateFrom || null,
  date_to: filter.dateTo || null,
});

function supplierInvoiceDraftInvokeArgs(input: SupplierInvoiceDraftSaveInput) {
  const id = input.id.trim();
  if (!id) {
    throw new Error(
      'L’identifiant technique du brouillon fournisseur est requis pour garantir une reprise sans doublon.',
    );
  }
  return {
    input: {
      id,
      supplier_id: input.supplierId,
      project_id: input.projectId || null,
      date: input.date,
      due_date: input.dueDate,
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || null,
      items: input.items.map((item) => ({
        id: item.id || null,
        description: item.description,
        quantity_milli: item.quantityMilli,
        unit: item.unit || null,
        unit_price_cents: item.unitPriceCents,
        discount_bp: item.discountBp || 0,
        vat_bp: item.vatBp,
        category: item.category,
        expense_account_id: item.expenseAccountId || null,
        project_id: item.projectId || null,
      })),
    },
  };
}

export const desktopApi = {
  loadWorkspace,
  async getNogaCatalog(): Promise<NogaCatalog> {
    const raw = await invoke<RawRecord>('get_noga_catalog');
    return {
      version: stringValue(raw.version),
      source: stringValue(raw.source),
      sections: rawArray(raw.sections).map((section) => ({
        code: stringValue(
          section.code,
        ) as NogaCatalog['sections'][number]['code'],
        label: stringValue(section.label),
        divisions: rawArray(section.divisions).map((division) => ({
          code: stringValue(division.code),
          label: stringValue(division.label),
        })),
      })),
    };
  },
  async getLicenseState(): Promise<LicenseState> {
    return licenseStateFromRaw(await invoke<RawRecord>('get_license_state'));
  },
  async installLicenseToken(token: string): Promise<LicenseState> {
    return licenseStateFromRaw(
      await invoke<RawRecord>('install_license_token', { token }),
    );
  },
  async refreshLicense(automatic = false): Promise<LicenseState> {
    return licenseStateFromRaw(
      await invoke<RawRecord>('refresh_license', { automatic }),
    );
  },
  async getCloudAccountState(): Promise<CloudAccountState> {
    return cloudAccountStateFromRaw(
      await invoke<RawRecord>('get_cloud_account_state'),
    );
  },
  async startCloudAccountLink(): Promise<CloudAccountState> {
    return cloudAccountStateFromRaw(
      await invoke<RawRecord>('start_cloud_account_link'),
    );
  },
  async pollCloudAccountLink(): Promise<CloudAccountState> {
    return cloudAccountStateFromRaw(
      await invoke<RawRecord>('poll_cloud_account_link'),
    );
  },
  openCloudAccountLink: () => invoke<string>('open_cloud_account_link'),
  openCloudAccountPortal: () => invoke<string>('open_cloud_account_portal'),
  disconnectCloudAccount: () => invoke<void>('disconnect_cloud_account'),
  async archiveInvoiceToCloud(
    invoiceId: string,
    correctionReason?: string,
  ): Promise<InvoiceArchiveResult> {
    const raw = await invoke<RawRecord>('archive_invoice_to_cloud', {
      invoiceId,
      correctionReason: correctionReason?.trim() || null,
    });
    return {
      archiveId: stringValue(raw.archiveId),
      revision: numberValue(raw.revision),
      contentSha256: stringValue(raw.contentSha256),
      retentionUntil: stringValue(raw.retentionUntil),
      alreadyStored: boolValue(raw.alreadyStored),
    };
  },
  async getSecureUpdatePolicy(): Promise<SecureUpdaterPolicy> {
    return secureUpdaterPolicyFromRaw(
      await invoke<RawRecord>('get_secure_update_policy'),
    );
  },
  async checkSecureUpdate(): Promise<SecureUpdateMetadata | null> {
    const raw = await invoke<RawRecord | null>('check_secure_update');
    return raw ? secureUpdateMetadataFromRaw(raw) : null;
  },
  async installSecureUpdate(
    onEvent: (event: SecureUpdateEvent) => void,
  ): Promise<void> {
    const channel = new Channel<unknown>();
    channel.onmessage = (value) => {
      const event = secureUpdateEventFromRaw(value);
      if (event) onEvent(event);
    };
    await invoke('install_secure_update', { onEvent: channel });
  },
  async validateOnboarding(
    settings: OnboardingPayload,
    scope: OnboardingValidationScope = 'complete',
  ): Promise<OnboardingValidationResult> {
    return onboardingValidationFromRaw(
      await invoke<RawRecord>('validate_onboarding', {
        input: settingsToBackend(settings),
        scope,
      }),
    );
  },
  async completeOnboarding(
    settings: OnboardingPayload,
    scope: OnboardingValidationScope = 'complete',
  ) {
    let response: RawRecord;
    try {
      response = recordValue(
        await invoke<RawRecord>('complete_onboarding', {
          input: settingsToBackend(settings),
          scope,
        }),
      );
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
      throw new Error(
        'La finalisation locale a renvoyé une réponse incomplète. Aucune donnée partielle n’a été conservée.',
      );
    }
    return normalizeWorkspace(workspace as RawWorkspace, appState);
  },
  async saveSettings(settings: AppSettings) {
    await invoke('update_settings', { data: settingsToBackend(settings) });
    return loadWorkspace();
  },
  async stageCompanyLogo(sourcePath: string) {
    return invoke<string>('stage_company_logo', { sourcePath });
  },
  async createEntity<T extends Record<string, unknown>>(
    entity: EntityKind,
    data: T,
  ) {
    await createRecord(entityToBackend[entity], toBackendData(data));
    return entity === 'employees' ? refreshWorkspaceAfterMutation(loadWorkspace) : loadWorkspace();
  },
  async saveProject(data: Record<string, unknown>, id?: string): Promise<string> {
    if (id) {
      await invoke('update_record', { entity: 'projects', id, data: toBackendData(data) });
      return id;
    }
    const record = await createRecord('projects', toBackendData(data));
    return stringValue(record.id);
  },
  async addProjectDocument(projectId: string, file: File) {
    return invoke('add_project_document', { input: {
      project_id: projectId, original_name: file.name, content_base64: await fileBase64(file),
    } });
  },
  async deleteProjectDocument(id: string) {
    await invoke('delete_project_document', { id });
    return loadWorkspace();
  },
  async readProjectDocument(id: string) {
    return invoke<string>('read_project_document', { id });
  },
  async updateEntity<T extends Record<string, unknown>>(
    entity: EntityKind,
    id: string,
    data: T,
  ) {
    await invoke('update_record', {
      entity: entityToBackend[entity],
      id,
      data: toBackendData(data),
    });
    return entity === 'employees' ? refreshWorkspaceAfterMutation(loadWorkspace) : loadWorkspace();
  },
  async saveProjectMilestone(input: {
    id?: string;
    projectId: string;
    title: string;
    description: string;
    dueDate: string | null;
    status: ProjectMilestone['status'];
    priority: ProjectMilestone['priority'];
    sortOrder: number;
    employeeId: string | null;
  }) {
    await invoke('save_project_milestone', {
      input: {
        id: input.id ?? null,
        project_id: input.projectId,
        title: input.title,
        description: input.description || null,
        due_date: input.dueDate,
        status: input.status,
        priority: input.priority,
        sort_order: input.sortOrder,
        employee_id: input.employeeId,
      },
    });
    return loadWorkspace();
  },
  async deleteProjectMilestone(id: string) {
    await invoke('delete_project_milestone', { id });
    return loadWorkspace();
  },
  async saveProjectTask(input: {
    id?: string;
    projectId: string;
    milestoneId: string | null;
    title: string;
    description: string;
    dueDate: string | null;
    priority: ProjectTask['priority'];
    sortOrder: number;
    employeeId: string | null;
  }) {
    await invoke('save_project_task', {
      input: {
        id: input.id ?? null,
        project_id: input.projectId,
        milestone_id: input.milestoneId,
        title: input.title,
        description: input.description || null,
        due_date: input.dueDate,
        priority: input.priority,
        sort_order: input.sortOrder,
        employee_id: input.employeeId,
      },
    });
    return loadWorkspace();
  },
  async setProjectTaskStatus(id: string, status: ProjectTask['status']) {
    await invoke('set_project_task_status', { id, status });
    return loadWorkspace();
  },
  async deleteProjectTask(id: string) {
    await invoke('delete_project_task', { id });
    return loadWorkspace();
  },
  async saveAgendaEvent(input: {
    id: string;
    isNew: boolean;
    expectedUpdatedAt: string | null;
    title: string;
    startDate: string;
    endDate: string;
    allDay: boolean;
    startTime: string | null;
    endTime: string | null;
    kind: AgendaEvent['kind'];
    status: AgendaEvent['status'];
    location: string;
    notes: string;
    projectId: string | null;
    employeeId: string | null;
  }) {
    await invoke('save_agenda_event', {
      input: {
        id: input.id,
        create_only: input.isNew,
        expected_updated_at: input.expectedUpdatedAt,
        title: input.title,
        start_date: input.startDate,
        end_date: input.endDate,
        all_day: input.allDay,
        start_time: input.allDay ? null : input.startTime,
        end_time: input.allDay ? null : input.endTime,
        kind: input.kind,
        status: input.status,
        location: input.location || null,
        notes: input.notes || null,
        project_id: input.projectId,
        employee_id: input.employeeId,
      },
    });
    return loadWorkspace();
  },
  async deleteAgendaEvent(id: string, expectedUpdatedAt: string) {
    await invoke('delete_agenda_event', { id, expectedUpdatedAt });
    return loadWorkspace();
  },
  async recordStockEntry(input: {
    requestId: string;
    catalogItemId: string;
    quantityMilli: number;
    reason: string;
    reference?: string;
    date?: string;
  }) {
    const mutation = stockMovementMutation('entry', input);
    await invoke(mutation.command, mutation.args);
    return loadWorkspace();
  },
  async recordStockExit(input: {
    requestId: string;
    catalogItemId: string;
    quantityMilli: number;
    reason: string;
    reference?: string;
    date?: string;
  }) {
    const mutation = stockMovementMutation('exit', input);
    await invoke(mutation.command, mutation.args);
    return loadWorkspace();
  },
  async recordStockCorrection(input: {
    requestId: string;
    catalogItemId: string;
    deltaQuantityMilli: number;
    reason: string;
    reference?: string;
    date?: string;
  }) {
    const mutation = stockMovementMutation('correction', {
      ...input,
      quantityMilli: input.deltaQuantityMilli,
    });
    await invoke(mutation.command, mutation.args);
    return loadWorkspace();
  },
  async archiveEntity(entity: EntityKind, id: string) {
    const mutation = archiveEntityMutation(entity, id);
    await invoke(mutation.command, mutation.args);
    return loadWorkspace();
  },
  async importCatalogItems(
    rows: CatalogImportRow[],
    conflictPolicy: 'update' | 'skip',
  ) {
    const mutation = importCatalogItemsMutation(rows, conflictPolicy);
    await invoke(mutation.command, mutation.args);
    return loadWorkspace();
  },
  async saveSupplierOrderDraft(input: {
    id?: string;
    supplierId: string;
    projectId?: string | null;
    title: string;
    orderDate: string;
    currency?: string;
    notes?: string;
    terms?: string;
    lines: Array<{
      id?: string;
      catalogItemId?: string | null;
      position: number;
      description: string;
      quantityMilli: number;
      unit: string;
      unitPriceCents: number;
      discountBp: number;
      vatBp: number;
      category: string;
      expenseAccountId?: string | null;
      projectId?: string | null;
      fulfillmentMode: SupplierOrderFulfillmentMode;
    }>;
  }) {
    await invoke('save_supplier_order_draft', {
      input: {
        order: {
          id: input.id ?? null,
          supplier_id: input.supplierId,
          project_id: input.projectId ?? null,
          title: input.title,
          order_date: input.orderDate,
          currency: input.currency || 'CHF',
          notes: input.notes?.trim() || null,
          terms: input.terms?.trim() || null,
        },
        lines: input.lines.map((line) => ({
          id: line.id ?? null,
          catalog_item_id: line.catalogItemId ?? null,
          position: line.position,
          description: line.description,
          quantity_milli: line.quantityMilli,
          unit: line.unit,
          unit_price_cents: line.unitPriceCents,
          discount_bp: line.discountBp,
          vat_bp: line.vatBp,
          category: line.category,
          expense_account_id: line.expenseAccountId ?? null,
          project_id: line.projectId ?? null,
          fulfillment_mode: line.fulfillmentMode,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async confirmSupplierOrder(requestId: string, supplierOrderId: string) {
    await invoke('confirm_supplier_order', {
      input: {
        request_id: requestId,
        supplier_order_id: supplierOrderId,
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async cancelSupplierOrderRemainder(
    requestId: string,
    supplierOrderId: string,
    reason: string,
    lines: Array<{ supplierOrderLineId: string; quantityMilli: number }>,
  ) {
    await invoke('cancel_supplier_order_remainder', {
      input: {
        request_id: requestId,
        supplier_order_id: supplierOrderId,
        reason: reason.trim(),
        lines: lines.map((line) => ({
          supplier_order_line_id: line.supplierOrderLineId,
          quantity_milli: line.quantityMilli,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async saveSupplierReceiptDraft(input: {
    id?: string;
    supplierOrderId: string;
    receiptDate: string;
    reference?: string;
    notes?: string;
    lines: Array<{ supplierOrderLineId: string; quantityMilli: number }>;
  }) {
    await invoke('save_supplier_receipt_draft', {
      input: {
        receipt: {
          id: input.id ?? null,
          supplier_order_id: input.supplierOrderId,
          receipt_date: input.receiptDate,
          reference: input.reference?.trim() || null,
          notes: input.notes?.trim() || null,
        },
        lines: input.lines.map((line) => ({
          supplier_order_line_id: line.supplierOrderLineId,
          quantity_milli: line.quantityMilli,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async issueSupplierReceipt(requestId: string, supplierReceiptId: string) {
    await invoke('issue_supplier_receipt', {
      input: {
        request_id: requestId,
        supplier_receipt_id: supplierReceiptId,
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async reverseSupplierReceipt(
    requestId: string,
    supplierReceiptId: string,
    reason: string,
  ) {
    await invoke('reverse_supplier_receipt', {
      input: {
        request_id: requestId,
        supplier_receipt_id: supplierReceiptId,
        reason: reason.trim(),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async saveSupplierInvoiceMatch(input: SaveSupplierInvoiceMatchDraftInput) {
    const allocationsByOrder = new Map<
      string,
      SaveSupplierInvoiceMatchDraftInput['allocations']
    >();
    for (const allocation of input.allocations) {
      const orderId = allocation.supplierOrderId || input.supplierOrderId;
      const group = allocationsByOrder.get(orderId) ?? [];
      group.push(allocation);
      allocationsByOrder.set(orderId, group);
    }
    const serializeAllocations = (
      allocations: SaveSupplierInvoiceMatchDraftInput['allocations'],
    ) =>
      allocations.map((allocation) => ({
        supplier_invoice_item_id: allocation.supplierInvoiceItemId,
        supplier_order_line_id: allocation.supplierOrderLineId,
        supplier_receipt_line_id: allocation.supplierReceiptLineId ?? null,
        quantity_milli: allocation.quantityMilli,
      }));
    await invoke('save_supplier_invoice_match', {
      input: {
        request_id: input.requestId,
        supplier_invoice_id: input.supplierInvoiceId,
        supplier_order_id: input.supplierOrderId,
        allocations: serializeAllocations(
          allocationsByOrder.get(input.supplierOrderId) ?? [],
        ),
        order_allocations: [...allocationsByOrder.entries()]
          .filter(([orderId]) => orderId !== input.supplierOrderId)
          .map(([orderId, allocations]) => ({
            supplier_order_id: orderId,
            allocations: serializeAllocations(allocations),
          })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async saveSupplierCreditNoteDraft(input: {
    id?: string;
    supplierId: string;
    documentDate: string;
    reference?: string;
    note?: string;
    items: Array<{
      id?: string;
      description: string;
      quantityMilli: number;
      unit?: string;
      unitPriceCents: number;
      discountBp?: number;
      vatBp: number;
      category: string;
      expenseAccountId?: string | null;
      projectId?: string | null;
    }>;
    allocations: Array<{ supplierInvoiceId: string; amountCents: number; effectiveDate: string }>;
  }) {
    await invoke('save_supplier_credit_note_draft', {
      input: {
        id: input.id ?? null,
        supplier_id: input.supplierId,
        document_date: input.documentDate,
        reference: input.reference?.trim() || null,
        note: input.note?.trim() || null,
        items: input.items.map((item) => ({
          id: item.id ?? null,
          description: item.description,
          quantity_milli: item.quantityMilli,
          unit: item.unit || null,
          unit_price_cents: item.unitPriceCents,
          discount_bp: item.discountBp || 0,
          vat_bp: item.vatBp,
          category: item.category,
          expense_account_id: item.expenseAccountId ?? null,
          project_id: item.projectId ?? null,
        })),
        allocations: input.allocations.map((allocation) => ({
          supplier_invoice_id: allocation.supplierInvoiceId,
          amount_cents: allocation.amountCents,
          effective_date: allocation.effectiveDate,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async validateSupplierCreditNote(
    requestId: string,
    supplierCreditNoteId: string,
  ) {
    await invoke('validate_supplier_credit_note', {
      input: {
        request_id: requestId,
        supplier_credit_note_id: supplierCreditNoteId,
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async deleteSupplierCreditNoteDraft(id: string) {
    await invoke('delete_supplier_credit_note_draft', { id });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async applySupplierCredit(
    requestId: string,
    supplierCreditNoteId: string,
    supplierInvoiceId: string,
    amountCents: number,
    effectiveDate: string,
  ) {
    await invoke('apply_supplier_credit', {
      input: {
        request_id: requestId,
        supplier_credit_note_id: supplierCreditNoteId,
        supplier_invoice_id: supplierInvoiceId,
        amount_cents: amountCents,
        effective_date: effectiveDate,
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async reverseSupplierCreditAllocation(
    requestId: string,
    supplierCreditAllocationId: string,
    reason: string,
    effectiveDate: string,
  ) {
    await invoke('reverse_supplier_credit_allocation', {
      input: {
        request_id: requestId,
        supplier_credit_allocation_id: supplierCreditAllocationId,
        reason: reason.trim(),
        effective_date: effectiveDate,
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async reclassifySupplierInvoiceExpense(input: {
    requestId: string;
    supplierInvoiceId: string;
    effectiveDate: string;
    reason: string;
    lines: Array<{
      supplierInvoiceItemId: string;
      newExpenseAccountId: string;
    }>;
  }) {
    await invoke('reclassify_supplier_invoice_expense', {
      input: {
        request_id: input.requestId,
        supplier_invoice_id: input.supplierInvoiceId,
        effective_date: input.effectiveDate,
        reason: input.reason.trim(),
        lines: input.lines.map((line) => ({
          supplier_invoice_item_id: line.supplierInvoiceItemId,
          new_expense_account_id: line.newExpenseAccountId,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async saveSupplierInvoiceDraft(input: SupplierInvoiceDraftSaveInput) {
    await invoke('save_supplier_invoice_draft',
      supplierInvoiceDraftInvokeArgs(input));
    return loadWorkspace();
  },
  async saveSupplierInvoiceDraftFromEmail(
    input: SupplierInvoiceDraftSaveInput,
    source: {
      sourcePath: string;
      sourceSha256: string;
      attachmentSha256: string;
    },
  ) {
    const { input: invoice } = supplierInvoiceDraftInvokeArgs(input);
    await invoke('import_supplier_email_invoice_draft', {
      input: {
        invoice,
        source_path: source.sourcePath,
        source_sha256: source.sourceSha256,
        attachment_sha256: source.attachmentSha256,
      },
    });
    return loadWorkspace();
  },
  async validateSupplierInvoice(id: string) {
    await invoke('validate_supplier_invoice', { id });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async recordSupplierPayment(input: {
    requestId: string;
    supplierInvoiceId: string;
    amountCents: number;
    date: string;
    method?: string;
    reference?: string;
    notes?: string;
  }) {
    await invoke('record_supplier_payment', {
      input: {
        request_id: input.requestId,
        supplier_invoice_id: input.supplierInvoiceId,
        amount_cents: input.amountCents,
        date: input.date,
        method: input.method?.trim() || null,
        reference: input.reference?.trim() || null,
        notes: input.notes?.trim() || null,
      },
    });
    return loadWorkspace();
  },
  async deleteSupplierInvoiceDraft(id: string) {
    await invoke('delete_supplier_invoice_draft', { id });
    return loadWorkspace();
  },
  async chooseSupplierEmailFile(): Promise<string | null> {
    return chooseFile({
      title: 'Choisir un e-mail contenant une facture fournisseur',
      multiple: false,
      filters: [
        {
          name: 'Messages e-mail exportés',
          extensions: ['eml', 'txt'],
        },
      ],
    });
  },
  async inspectSupplierEmailFile(
    sourcePath: string,
  ): Promise<SupplierEmailInspection> {
    const raw = await invoke<RawRecord>('inspect_supplier_email_file', {
      sourcePath,
    });
    return supplierEmailInspectionFromRaw(raw);
  },
  async chooseSupplierInvoiceAttachment(): Promise<string | null> {
    return chooseFile({
      title: 'Choisir un justificatif fournisseur',
      multiple: false,
      filters: [
        {
          name: 'Documents acceptés',
          extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'],
        },
      ],
    });
  },
  async addSupplierInvoiceAttachment(
    supplierInvoiceId: string,
    sourcePath: string,
  ) {
    await invoke('add_supplier_invoice_attachment', {
      input: {
        supplier_invoice_id: supplierInvoiceId,
        source_path: sourcePath,
      },
    });
    return loadWorkspace();
  },
  async deleteSupplierInvoiceAttachment(id: string) {
    await invoke('delete_supplier_invoice_attachment', { id });
    return loadWorkspace();
  },
  async openAttachment(id: string) {
    return invoke<string>('open_attachment', { id });
  },
  saveDocument,
  async createInvoiceCorrection(originalInvoiceId: string, reason: string) {
    const raw = await invoke<RawRecord>('create_invoice_correction', {
      input: {
        original_invoice_id: originalInvoiceId,
        reason,
      },
    });
    return {
      workspace: await loadWorkspace(),
      workflowId: stringValue(raw.workflow_id),
      creditNoteId: stringValue(raw.credit_note_id),
      replacementInvoiceId: stringValue(raw.replacement_invoice_id),
    };
  },
  async abandonInvoiceCorrection(workflowId: string) {
    await invoke('abandon_invoice_correction', {
      input: { workflow_id: workflowId },
    });
    return loadWorkspace();
  },
  async issueDocument(
    entity: 'quotes' | 'invoices',
    id: string,
    issueDate?: string,
    dueDate?: string,
  ) {
    if (entity === 'quotes')
      await invoke('issue_quote', { id, issueDate, validUntil: dueDate });
    else await invoke('issue_invoice', { id, issueDate, dueDate });
    return loadWorkspace();
  },
  async updateQuoteStatus(
    id: string,
    status: 'accepted' | 'refused' | 'expired' | 'cancelled',
  ) {
    await invoke('update_quote_status', { id, status });
    return loadWorkspace();
  },
  async createQuoteRevision(requestId: string, id: string) {
    const raw = await invoke<RawRecord>('create_quote_revision', { requestId, id });
    const revisionId = stringValue(recordValue(raw.revision).id);
    if (!revisionId) {
      throw new Error('La révision créée n’a pas renvoyé d’identifiant exploitable.');
    }
    return { revisionId, workspace: await loadWorkspace() };
  },
  async convertQuote(quote: Quote, depositPercentageBp: number | null = null) {
    const mutation = convertQuoteMutation(quote, depositPercentageBp);
    await invoke(mutation.command, mutation.args);
    return loadWorkspace();
  },
  async convertQuoteToSalesOrder(requestId: string, quoteId: string) {
    await invoke('convert_quote_to_sales_order', {
      input: { request_id: requestId, quote_id: quoteId },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async saveSalesOrderDraft(input: {
    id?: string;
    clientId: string;
    projectId?: string | null;
    title: string;
    orderDate: string;
    currency?: string;
    notes?: string;
    terms?: string;
    lines: Array<{
      id?: string;
      catalogItemId?: string | null;
      position: number;
      description: string;
      quantityMilli: number;
      unit: string;
      unitPriceCents: number;
      discountBp: number;
      vatBp: number;
      fulfillmentMode: SalesOrderFulfillmentMode;
    }>;
  }) {
    await invoke('save_sales_order_draft', {
      input: {
        order: {
          id: input.id ?? null,
          client_id: input.clientId,
          project_id: input.projectId ?? null,
          title: input.title,
          order_date: input.orderDate,
          currency: input.currency || 'CHF',
          notes: input.notes?.trim() || null,
          terms: input.terms?.trim() || null,
        },
        lines: input.lines.map((line) => ({
          id: line.id ?? null,
          catalog_item_id: line.catalogItemId ?? null,
          position: line.position,
          description: line.description,
          quantity_milli: line.quantityMilli,
          unit: line.unit,
          unit_price_cents: line.unitPriceCents,
          discount_bp: line.discountBp,
          vat_bp: line.vatBp,
          fulfillment_mode: line.fulfillmentMode,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async confirmSalesOrder(requestId: string, salesOrderId: string) {
    await invoke('confirm_sales_order', {
      input: { request_id: requestId, sales_order_id: salesOrderId },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async createRecurrenceSchedule(input: CreateRecurrenceScheduleInput) {
    const mutation = createRecurrenceScheduleMutation(input);
    await invoke(mutation.command, mutation.args);
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async updateRecurrenceSchedule(input: UpdateRecurrenceScheduleInput) {
    const mutation = updateRecurrenceScheduleMutation(input);
    await invoke(mutation.command, mutation.args);
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async generateRecurrenceOccurrences(
    input: GenerateRecurrenceOccurrencesInput,
  ) {
    const mutation = generateRecurrenceOccurrencesMutation(input);
    await invoke(mutation.command, mutation.args);
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async cancelSalesOrder(
    requestId: string,
    salesOrderId: string,
    reason: string,
  ) {
    await invoke('cancel_sales_order', {
      input: {
        request_id: requestId,
        sales_order_id: salesOrderId,
        reason: reason.trim(),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async cancelSalesOrderRemainder(
    requestId: string,
    salesOrderId: string,
    reason: string,
    lines: Array<{ salesOrderLineId: string; quantityMilli: number }>,
  ) {
    await invoke('cancel_sales_order_remainder', {
      input: {
        request_id: requestId,
        sales_order_id: salesOrderId,
        reason: reason.trim(),
        lines: lines.map((line) => ({
          sales_order_line_id: line.salesOrderLineId,
          quantity_milli: line.quantityMilli,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async saveDeliveryNoteDraft(input: {
    id?: string;
    salesOrderId: string;
    deliveryDate: string;
    reference?: string;
    notes?: string;
    lines: Array<{ salesOrderLineId: string; quantityMilli: number }>;
  }) {
    await invoke('save_delivery_note_draft', {
      input: {
        delivery_note: {
          id: input.id ?? null,
          sales_order_id: input.salesOrderId,
          delivery_date: input.deliveryDate,
          reference: input.reference?.trim() || null,
          notes: input.notes?.trim() || null,
        },
        lines: input.lines.map((line) => ({
          sales_order_line_id: line.salesOrderLineId,
          quantity_milli: line.quantityMilli,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async issueDeliveryNote(requestId: string, deliveryNoteId: string) {
    await invoke('issue_delivery_note', {
      input: { request_id: requestId, delivery_note_id: deliveryNoteId },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async reverseDeliveryNote(
    requestId: string,
    deliveryNoteId: string,
    reason: string,
  ) {
    await invoke('reverse_delivery_note', {
      input: {
        request_id: requestId,
        delivery_note_id: deliveryNoteId,
        reason: reason.trim(),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async previewSalesOrderInvoice(input: {
    salesOrderId: string;
    allocations: Array<{
      salesOrderLineId: string;
      deliveryNoteLineId: string | null;
      quantityMilli: number;
    }>;
  }): Promise<SalesOrderInvoicePreview> {
    const response = recordValue(
      await invoke<unknown>('preview_sales_order_invoice', {
        input: {
          sales_order_id: input.salesOrderId,
          allocations: input.allocations.map((allocation) => ({
            sales_order_line_id: allocation.salesOrderLineId,
            delivery_note_line_id: allocation.deliveryNoteLineId,
            quantity_milli: allocation.quantityMilli,
          })),
        },
      }),
    );
    const raw = Object.keys(recordValue(response.preview)).length
      ? recordValue(response.preview)
      : response;
    const rawRole = stringValue(raw.role) || stringValue(raw.invoice_role);
    return {
      role: rawRole === 'final' || rawRole === 'finale' ? 'final' : 'partial',
      subtotalCents: numberValue(raw.subtotal_cents),
      discountCents: numberValue(raw.discount_cents),
      vatCents: numberValue(raw.vat_cents),
      totalCents: numberValue(raw.total_cents),
      blockers: Array.isArray(raw.blockers)
        ? raw.blockers.map((blocker) => stringValue(blocker)).filter(Boolean)
        : [],
    };
  },
  async createSalesOrderInvoice(input: {
    requestId: string;
    salesOrderId: string;
    issueDate?: string;
    dueDate?: string;
    serviceDateFrom: string;
    serviceDateTo: string;
    allocations: Array<{
      salesOrderLineId: string;
      deliveryNoteLineId: string | null;
      quantityMilli: number;
    }>;
  }) {
    await invoke('create_sales_order_invoice', {
      input: {
        request_id: input.requestId,
        sales_order_id: input.salesOrderId,
        issue_date: input.issueDate || null,
        due_date: input.dueDate || null,
        service_date_from: input.serviceDateFrom,
        service_date_to: input.serviceDateTo,
        allocations: input.allocations.map((allocation) => ({
          sales_order_line_id: allocation.salesOrderLineId,
          delivery_note_line_id: allocation.deliveryNoteLineId,
          quantity_milli: allocation.quantityMilli,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async cancelSalesOrderInvoiceDraft(
    requestId: string,
    invoiceId: string,
    reason: string,
  ) {
    await invoke('cancel_sales_order_invoice_draft', {
      input: {
        request_id: requestId,
        invoice_id: invoiceId,
        reason: reason.trim(),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async addPayment(
    invoiceId: string,
    data: {
      requestId: string;
      amountCents: number;
      date: string;
      method: string;
      reference: string;
      notes: string;
    },
  ) {
    await invoke('record_payment', {
      input: { invoice_id: invoiceId, ...toBackendData(data) },
    });
    return loadWorkspace();
  },
  async savePayslip(
    data: Record<string, unknown>,
    lines: PayslipLine[],
    existing?: Payslip,
  ) {
    let payslipId = existing?.id;
    if (payslipId)
      await invoke('update_record', {
        entity: 'payslips',
        id: payslipId,
        data: toBackendData(data),
      });
    else
      payslipId = stringValue(
        (await createRecord('payslips', toBackendData(data))).id,
      );
    if (!payslipId)
      throw new Error('La fiche de salaire locale n’a pas pu être identifiée.');
    const previous = existing?.lines ?? [];
    const retained = new Set(
      lines
        .filter((line) => previous.some((old) => old.id === line.id))
        .map((line) => line.id),
    );
    for (const old of previous)
      if (!retained.has(old.id))
        await invoke('delete_record', { entity: 'payslip_items', id: old.id });
    for (const [position, line] of lines.entries()) {
      const lineData = {
        payslip_id: payslipId,
        position,
        label: line.label,
        kind: line.kind,
        amount_cents: line.amountCents,
        posting_account_id: line.postingAccountId || null,
        expense_account_id: line.expenseAccountId || null,
      };
      if (previous.some((old) => old.id === line.id))
        await invoke('update_record', {
          entity: 'payslip_items',
          id: line.id,
          data: lineData,
        });
      else await createRecord('payslip_items', lineData);
    }
    return loadWorkspace();
  },
  async savePayslipWithContributions(
    data: Record<string, unknown>,
    lines: PayslipLine[],
    existing: Payslip | undefined,
    period: string,
    selections: PayrollContributionSelection[],
  ) {
    await invoke('save_payslip_with_contributions', {
      input: {
        id: existing?.id ?? null,
        employee_id: String(data.employeeId ?? ''),
        period,
        status:
          statusToBackend[String(data.status ?? 'incomplete')] ?? 'a_controler',
        payment_date: String(data.paymentDate ?? '') || null,
        notes: String(data.notes ?? '') || null,
        lines: lines.map((line) => ({
          id: existing?.lines.some((candidate) => candidate.id === line.id)
            ? line.id
            : null,
          label: line.label,
          kind: line.kind,
          amount_cents: line.amountCents,
          posting_account_id: line.postingAccountId || null,
          expense_account_id: line.expenseAccountId || null,
        })),
        contributions: selections.map((item) => ({
          definition_id: item.definitionId,
          basis_cents: item.basisCents ?? null,
          year_to_date_basis_cents: item.yearToDateBasisCents ?? null,
        })),
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async startTimer(data: Record<string, unknown>) {
    await invoke('start_timer', { input: toBackendData(data) });
    return loadWorkspace();
  },
  async stopTimer() {
    await invoke('stop_timer');
    return loadWorkspace();
  },
  async createInvoiceFromTimeEntries(input: {
    requestId: string;
    projectId: string;
    timeEntryIds: string[];
    title?: string;
    vatBp?: number;
    notes?: string;
  }) {
    await invoke('create_invoice_from_time_entries', {
      input: {
        request_id: input.requestId,
        project_id: input.projectId,
        time_entry_ids: input.timeEntryIds,
        title: input.title?.trim() || null,
        service_date_from: null,
        service_date_to: null,
        vat_bp: input.vatBp ?? null,
        notes: input.notes?.trim() || null,
      },
    });
    return loadWorkspace();
  },
  async createBackup(destination?: string) {
    const path = await invoke<string>('create_backup', { destination: isMobileRuntime() ? undefined : destination });
    await shareMobileExport(path);
    return { workspace: await loadWorkspace(), path };
  },
  chooseCamtFile: () =>
    chooseFile({
      multiple: false,
      directory: false,
      title: 'Importer un relevé bancaire CAMT',
      filters: [{ name: 'Relevé bancaire ISO 20022', extensions: ['xml'] }],
    }),
  async importCamtFile(path: string, autoReconcile = true) {
    return camtImportResultFromRaw(
      await invoke<RawRecord>('import_camt_file', { path, autoReconcile }),
    );
  },
  async getBankWorkspace(): Promise<BankWorkspace> {
    return bankWorkspaceFromRaw(await invoke<RawRecord>('get_bank_workspace'));
  },
  async associateBankAccount(
    accountId: string,
    currency: string,
  ): Promise<void> {
    await invoke(
      'associate_bank_account',
      bankAccountAssociationPayload(accountId, currency),
    );
  },
  async dissociateBankAccount(
    accountId: string,
    currency: string,
  ): Promise<void> {
    await invoke(
      'dissociate_bank_account',
      bankAccountAssociationPayload(accountId, currency),
    );
  },
  async confirmBankReconciliation(
    movementId: string,
    invoiceId: string,
  ): Promise<BankReconciliationResult> {
    return bankReconciliationResultFromRaw(
      await invoke<RawRecord>(
        'confirm_bank_reconciliation',
        bankConfirmationPayload(movementId, invoiceId),
      ),
    );
  },
  async confirmSupplierBankReconciliation(
    movementId: string,
    supplierInvoiceId: string,
  ): Promise<BankSupplierReconciliationResult> {
    return bankSupplierReconciliationResultFromRaw(
      await invoke<RawRecord>(
        'confirm_supplier_bank_reconciliation',
        supplierBankConfirmationPayload(movementId, supplierInvoiceId),
      ),
    );
  },
  async confirmExpenseBankReconciliation(movementId: string, expenseId: string, dateDifferenceReason: string | undefined, requestId: string): Promise<void> {
    await invoke('confirm_expense_bank_reconciliation', { input: { request_id: requestId, movement_id: movementId, expense_id: expenseId, date_difference_reason: dateDifferenceReason || null } });
  },
  async unreconcileBankExpense(requestId: string, reconciliationId: string, reason: string): Promise<void> {
    await invoke('unreconcile_bank_expense', { input: { request_id: requestId, reconciliation_id: reconciliationId, reason } });
  },
  async createBankExpense(draft: import('./BankExpenseForm').BankExpenseDraft): Promise<void> {
    await invoke('create_bank_expense', { input: { request_id: draft.requestId, movement_id: draft.movementId, date: draft.date, supplier: draft.supplier, reference: draft.reference, category: draft.category, project_id: draft.projectId, vat_cents: draft.vatCents, vat_treatment: draft.vatTreatment, note: draft.note, original_name: draft.receipt.name, content_base64: await fileBase64(draft.receipt) } });
  },
  chooseRestoreFile: () =>
    chooseFile({
      multiple: false,
      directory: false,
      title: 'Choisir une sauvegarde Zentra',
      filters: [
        {
          name: 'Sauvegarde Zentra',
          extensions: ['zentra', 'elyko', 'hchantier'],
        },
      ],
    }),
  async restoreBackup(source: string) {
    await invoke<AppState>('restore_backup', { source });
    return loadWorkspace();
  },
  async exportData(format: 'json' | 'csv') {
    const command = format === 'json' ? 'export_json' : 'export_csv_archive';
    const path = await invoke<string>(command, {});
    await shareMobileExport(path);
    return { path };
  },
  chooseBackupFolder: () =>
    chooseFile({
      directory: true,
      multiple: false,
      title: 'Choisir le dossier de sauvegarde',
    }),
  chooseLogo: () =>
    chooseFile({
      multiple: false,
      directory: false,
      title: 'Choisir le logo',
      filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    }),
  choosePayrollDocuments: () =>
    chooseFiles({
      multiple: true,
      directory: false,
      title: 'Ajouter des fiches de salaire',
      filters: [
        {
          name: 'Fiches de salaire',
          extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'],
        },
      ],
    }),
  async stagePayrollDocuments(
    paths: string[],
  ): Promise<PayrollDocumentImport[]> {
    const raw = await invoke<RawRecord>('stage_payroll_documents', {
      input: { paths },
    });
    return rawArray(raw, 'imports').map(payrollImportFromRaw);
  },
  async listPayrollDocumentImports(): Promise<PayrollDocumentImport[]> {
    const raw = await invoke<RawRecord>('list_payroll_document_imports');
    return rawArray(raw, 'imports').map(payrollImportFromRaw);
  },
  async getPayrollDocumentPreview(
    id: string,
  ): Promise<{ mimeType: string; dataBase64: string }> {
    const raw = await invoke<RawRecord>('get_payroll_document_preview', { id });
    const mimeType = stringValue(raw.mime_type);
    const dataBase64 = stringValue(raw.data_base64);
    if (!mimeType || !dataBase64)
      throw new Error('L’aperçu local du document est incomplet.');
    return { mimeType, dataBase64 };
  },
  async updatePayrollImportDraft(
    id: string,
    draft: PayrollImportDraft,
    extractionEngine: string,
    engineVersion: string,
    confidenceBp: number,
    analysisManifest?: PayrollAnalysisManifest | null,
  ): Promise<PayrollDocumentImport> {
    const mutation = updatePayrollImportDraftMutation(
      id,
      draft,
      extractionEngine,
      engineVersion,
      confidenceBp,
      analysisManifest,
    );
    const row = await invoke<RawRecord>(mutation.command, mutation.args);
    return payrollImportFromRaw(row);
  },
  async confirmPayrollDocumentImport(
    id: string,
    draft: PayrollImportDraft,
    employeeId?: string,
    replaceExistingTemplate = false,
    humanReviewAttested = false,
  ): Promise<Workspace> {
    await invoke('confirm_payroll_document_import', {
      input: {
        id,
        employee_id: employeeId || null,
        replace_existing_template: replaceExistingTemplate,
        human_review_attested: humanReviewAttested,
        human_review_attestation_version: humanReviewAttested
          ? 'zentra.payroll-import.human-review.v1'
          : '',
        draft: payrollImportDraftToRaw(draft),
      },
    });
    return loadWorkspace();
  },
  async rejectPayrollDocumentImport(id: string): Promise<Workspace> {
    await invoke('reject_payroll_document_import', { id });
    return loadWorkspace();
  },
  async listAccounts() {
    return rawArray(await invoke<unknown>('list_accounts')).map(accountFromRaw);
  },
  async upsertAccount(input: Omit<Account, 'id'> & { id?: string }) {
    await invoke('upsert_account', {
      input: {
        id: input.id || null,
        code: input.code,
        name: input.name,
        account_type: input.accountType,
        normal_balance: input.normalBalance,
        report_section: input.reportSection,
        active: input.active,
      },
    });
  },
  async deleteAccount(id: string) {
    await invoke('delete_account', { id });
  },
  async getAccountingSettings() {
    const raw = await invoke<RawRecord | null>('get_accounting_settings');
    return accountingSettingsFromRaw(raw);
  },
  async getAccountingContinuity() {
    return accountingContinuityFromRaw(
      await invoke<RawRecord>('get_accounting_continuity'),
    );
  },
  async installSwissAccountingStarter() {
    return accountingConfigurationFromRaw(
      await invoke<unknown>('install_swiss_accounting_starter'),
    );
  },
  async listAccountingPeriods(): Promise<AccountingPeriod[]> {
    return rawArray(await invoke<unknown>('list_accounting_periods')).map(
      accountingPeriodFromRaw,
    );
  },
  async upsertAccountingPeriod(input: {
    id?: string;
    name: string;
    dateFrom: string;
    dateTo: string;
  }) {
    await invoke('upsert_accounting_period', {
      input: {
        id: input.id || null,
        name: input.name,
        date_from: input.dateFrom,
        date_to: input.dateTo,
      },
    });
  },
  async closeAccountingPeriod(id: string) {
    await invoke('close_accounting_period', { id });
  },
  async prepareFiduciaryPreClosing(
    filter: PeriodFilter,
  ): Promise<FiduciaryClosingReview> {
    return fiduciaryReviewFromRaw(
      await invoke('prepare_fiduciary_pre_closing', {
        filter: periodFilterToRaw(filter),
      }),
    );
  },
  async finalizeAccountingPeriodWithReview(
    periodId: string,
    reviewId: string,
  ): Promise<FiduciaryPeriodFinalization> {
    const row = recordValue(
      await invoke('finalize_accounting_period_with_review', {
        periodId,
        reviewId,
      }),
    );
    return {
      schema: 'elyko.fiduciary-period-finalization.v1',
      reviewId: stringValue(row.review_id),
      sourceSha256: stringValue(row.source_sha256),
      period: accountingPeriodFromRaw(recordValue(row.period)),
    };
  },
  async exportFiduciaryClosingZip(
    reviewId: string,
  ): Promise<FiduciaryPackageExport> {
    const row = recordValue(
      await invoke('export_fiduciary_closing_zip', { reviewId }),
    );
    const result: FiduciaryPackageExport = {
      schema: 'elyko.fiduciary-package-export.v1',
      exportId: stringValue(row.export_id),
      reviewId: stringValue(row.review_id),
      createdAt: stringValue(row.created_at),
      period: accountingPeriodFromRaw(recordValue(row.period)),
      packageStatus: stringValue(
        row.package_status,
      ) as FiduciaryPackageExport['packageStatus'],
      sourceSha256: stringValue(row.source_sha256),
      manifestSha256: stringValue(row.manifest_sha256),
      fileName: stringValue(row.file_name),
      path: stringValue(row.path),
      fileCount: numberValue(row.file_count),
      disclaimer: stringValue(row.disclaimer),
    };
    try {
      await shareMobileExport(result.path);
    } catch {
      result.deliveryWarning = 'Le dossier a été créé, mais le partage n’a pas abouti. Utilisez « Partager le dossier » pour réessayer.';
    }
    return result;
  },
  async shareExistingExport(path: string): Promise<void> {
    await shareMobileExport(path);
  },
  async configureAccounting(settings: AccountingSettings) {
    return accountingConfigurationFromRaw(
      await invoke<unknown>('configure_accounting', {
        input: {
          enabled: settings.enabled,
          ar_account_id: settings.arAccountId || null,
          revenue_account_id: settings.revenueAccountId || null,
          vat_payable_account_id: settings.vatPayableAccountId || null,
          vat_deferred_payable_account_id:
            settings.vatDeferredPayableAccountId || null,
          bank_account_id: settings.bankAccountId || null,
          expense_account_id: settings.expenseAccountId || null,
          vat_receivable_account_id: settings.vatReceivableAccountId || null,
          wages_expense_account_id: settings.wagesExpenseAccountId || null,
          wages_payable_account_id: settings.wagesPayableAccountId || null,
          social_expense_account_id: settings.socialExpenseAccountId || null,
          social_payable_account_id: settings.socialPayableAccountId || null,
          supplier_payable_account_id:
            settings.supplierPayableAccountId || null,
        },
      }),
    );
  },
  async postManualJournalEntry(
    input: ManualJournalSubmission & { requestId: string },
  ) {
    await invoke('post_manual_journal_entry', {
      requestId: input.requestId,
      input: {
        entry_date: input.entryDate,
        description: input.description,
        currency: 'CHF',
        lines: input.lines.map((line) => ({
          account_id: line.accountId,
          debit_cents: line.debitCents,
          credit_cents: line.creditCents,
          memo: line.memo || null,
          project_id: line.projectId || null,
          client_id: line.clientId || null,
          employee_id: line.employeeId || null,
        })),
      },
    });
  },
  async reverseJournalEntry(
    id: string,
    entryDate: string,
    description?: string,
  ) {
    await invoke('reverse_journal_entry', {
      id,
      entryDate,
      description: description || null,
    });
  },
  async getJournal(filter: PeriodFilter): Promise<JournalReport> {
    const raw = await invoke<RawRecord>('get_journal', {
      filter: periodFilterToRaw(filter),
    });
    return {
      entries: rawArray(raw.entries).map(journalEntryFromRaw),
      lines: rawArray(raw.lines).map(journalLineFromRaw),
      currency: reportCurrencyFromRaw(raw.currency),
    };
  },
  async getLedger(
    accountId: string,
    filter: PeriodFilter,
  ): Promise<LedgerReport> {
    const raw = await invoke<RawRecord>('get_ledger', {
      input: { account_id: accountId, ...periodFilterToRaw(filter) },
    });
    return {
      account: accountFromRaw(raw.account as RawRecord),
      lines: rawArray(raw.lines).map(journalLineFromRaw),
      currency: reportCurrencyFromRaw(raw.currency),
      openingDebitCents: numberValue(raw.opening_debit_cents),
      openingCreditCents: numberValue(raw.opening_credit_cents),
      openingDebitBalanceCents: numberValue(raw.opening_debit_balance_cents),
      openingCreditBalanceCents: numberValue(raw.opening_credit_balance_cents),
      openingNetDebitCents: numberValue(raw.opening_net_debit_cents),
      debitCents: numberValue(raw.debit_cents),
      creditCents: numberValue(raw.credit_cents),
      movementNetDebitCents: numberValue(raw.movement_net_debit_cents),
      netDebitCents: numberValue(raw.net_debit_cents),
      closingDebitBalanceCents: numberValue(raw.closing_debit_balance_cents),
      closingCreditBalanceCents: numberValue(raw.closing_credit_balance_cents),
      closingNetDebitCents: numberValue(raw.closing_net_debit_cents),
    };
  },
  async getTrialBalance(filter: PeriodFilter): Promise<TrialBalanceReport> {
    const raw = await invoke<RawRecord>('get_trial_balance', {
      filter: periodFilterToRaw(filter),
    });
    const rows: TrialBalanceRow[] = rawArray(raw.rows).map((row) => ({
      ...accountFromRaw(row),
      openingDebitCents: numberValue(row.opening_debit_cents),
      openingCreditCents: numberValue(row.opening_credit_cents),
      openingDebitBalanceCents: numberValue(row.opening_debit_balance_cents),
      openingCreditBalanceCents: numberValue(row.opening_credit_balance_cents),
      openingNetDebitCents: numberValue(row.opening_net_debit_cents),
      debitCents: numberValue(row.debit_cents),
      creditCents: numberValue(row.credit_cents),
      debitBalanceCents: numberValue(row.debit_balance_cents),
      creditBalanceCents: numberValue(row.credit_balance_cents),
      closingNetDebitCents: numberValue(row.closing_net_debit_cents),
    }));
    return {
      rows,
      currency: reportCurrencyFromRaw(raw.currency),
      openingDebitBalanceCents: numberValue(raw.opening_debit_balance_cents),
      openingCreditBalanceCents: numberValue(raw.opening_credit_balance_cents),
      debitCents: numberValue(raw.debit_cents),
      creditCents: numberValue(raw.credit_cents),
      closingDebitBalanceCents: numberValue(raw.closing_debit_balance_cents),
      closingCreditBalanceCents: numberValue(raw.closing_credit_balance_cents),
      balanced: boolValue(raw.balanced),
    };
  },
  async exportAnnualAccountsPdf(filter: PeriodFilter) {
    const selected = await chooseSaveFile({ title: 'Exporter le bilan et le résultat', defaultPath: `Zentra-bilan-${filter.dateTo || new Date().toISOString().slice(0, 10)}.pdf`, filters: [{ name: 'Bilan et compte de résultat PDF', extensions: ['pdf'] }] });
    if (!selected) return null;
    const raw = await invoke<RawRecord>('export_annual_accounts_pdf', { filter: periodFilterToRaw(filter), destinationPath: pdfDestinationPath(selected) });
    await shareMobileExport(stringValue(raw.path));
    return { path: stringValue(raw.path), pages: numberValue(raw.pages), closed: boolValue(raw.closed), balanced: boolValue(raw.balanced) };
  },
  async getBalanceSheet(filter: PeriodFilter): Promise<BalanceSheetReport> {
    const raw = await invoke<RawRecord>('get_balance_sheet', {
      filter: periodFilterToRaw(filter),
    });
    return {
      asOf: stringValue(raw.as_of),
      exerciseFrom: stringValue(raw.exercise_from),
      scope: statementScopeFromRaw(raw.scope),
      currency: reportCurrencyFromRaw(raw.currency),
      rows: rawArray(raw.rows).map(statementRowFromRaw),
      sections: numberRecord(raw.sections),
      previousSections: numberRecord(raw.previous_sections),
      assetsCents: numberValue(raw.assets_cents),
      liabilitiesCents: numberValue(raw.liabilities_cents),
      equityCents: numberValue(raw.equity_cents),
      currentResultCents: numberValue(raw.current_result_cents),
      unallocatedPriorResultsCents: numberValue(
        raw.unallocated_prior_results_cents,
      ),
      balanced: boolValue(raw.balanced),
      previousAssetsCents: numberValue(raw.previous_assets_cents),
      previousLiabilitiesCents: numberValue(raw.previous_liabilities_cents),
      previousEquityCents: numberValue(raw.previous_equity_cents),
      previousCurrentResultCents: numberValue(
        raw.previous_current_result_cents,
      ),
      previousUnallocatedPriorResultsCents: numberValue(
        raw.previous_unallocated_prior_results_cents,
      ),
      previousBalanced: boolValue(raw.previous_balanced),
    };
  },
  async getIncomeStatement(
    filter: PeriodFilter,
  ): Promise<IncomeStatementReport> {
    const raw = await invoke<RawRecord>('get_income_statement', {
      filter: periodFilterToRaw(filter),
    });
    return {
      scope: statementScopeFromRaw(raw.scope),
      currency: reportCurrencyFromRaw(raw.currency),
      rows: rawArray(raw.rows).map(statementRowFromRaw),
      sections: numberRecord(raw.sections),
      previousSections: numberRecord(raw.previous_sections),
      revenueCents: numberValue(raw.revenue_cents),
      expenseCents: numberValue(raw.expense_cents),
      profitCents: numberValue(raw.profit_cents),
      previousRevenueCents: numberValue(raw.previous_revenue_cents),
      previousExpenseCents: numberValue(raw.previous_expense_cents),
      previousProfitCents: numberValue(raw.previous_profit_cents),
    };
  },
  async createVatProfile(input: {
    effectiveFrom: string;
    effectiveTo?: string;
    reportingMethod: VatReportingMethod;
    formOfReporting: VatReportingBasis;
    periodicity: VatReportingPeriodicity;
    grossOrNet?: 'net' | 'gross';
    tdfnActivityId?: string;
    tdfnRateBp?: number;
    afcAuthorizationConfirmed: boolean;
    notes?: string;
    closePreviousOpenProfile?: boolean;
  }): Promise<VatProfile> {
    return vatProfileFromRaw(
      await invoke('create_vat_profile', {
        input: {
          id: null,
          effective_from: input.effectiveFrom,
          effective_to: input.effectiveTo || null,
          reporting_method: input.reportingMethod,
          form_of_reporting: input.formOfReporting,
          periodicity: input.periodicity,
          gross_or_net: input.grossOrNet || 'net',
          tdfn_activity_id: input.tdfnActivityId || null,
          tdfn_rate_bp: input.tdfnRateBp ?? null,
          afc_authorization_confirmed: input.afcAuthorizationConfirmed,
          notes: input.notes?.trim() || null,
          close_previous_open_profile: input.closePreviousOpenProfile ?? false,
        },
      }),
    );
  },
  async listVatProfiles(): Promise<VatProfile[]> {
    return rawArray(await invoke('list_vat_profiles')).map(vatProfileFromRaw);
  },
  async setVatSourceClassification(input: {
    sourceType: VatSourceType;
    sourceId: string;
    treatment: VatSourceTreatment;
    note?: string;
  }): Promise<VatSourceClassification> {
    return vatClassificationFromRaw(
      await invoke('set_vat_source_classification', {
        input: {
          source_type: input.sourceType,
          source_id: input.sourceId,
          treatment: input.treatment,
          note: input.note?.trim() || null,
        },
      }),
    );
  },
  async listVatSourceClassifications(input?: {
    sourceType?: VatSourceType;
    sourceId?: string;
  }): Promise<VatSourceClassification[]> {
    return rawArray(
      await invoke('list_vat_source_classifications', {
        input: {
          source_type: input?.sourceType || null,
          source_id: input?.sourceId || null,
        },
      }),
    ).map(vatClassificationFromRaw);
  },
  async createVatAdjustment(input: {
    requestId: string;
    adjustmentDate: string;
    category: VatAdjustmentCategory;
    amountCents: number;
    taxRateBp?: number;
    description: string;
    evidenceReference?: string;
    createdBy: string;
  }): Promise<VatAdjustment> {
    return vatAdjustmentFromRaw(
      await invoke('create_vat_adjustment', {
        input: {
          request_id: input.requestId.trim(),
          adjustment_date: input.adjustmentDate,
          category: input.category,
          amount_cents: input.amountCents,
          tax_rate_bp: input.taxRateBp ?? null,
          description: input.description,
          evidence_reference: input.evidenceReference?.trim() || null,
          created_by: input.createdBy,
        },
      }),
    );
  },
  async reverseVatAdjustment(input: {
    requestId: string;
    originalAdjustmentId: string;
    adjustmentDate: string;
    description: string;
    evidenceReference?: string;
    createdBy: string;
  }): Promise<VatAdjustment> {
    return vatAdjustmentFromRaw(
      await invoke('reverse_vat_adjustment', {
        input: {
          request_id: input.requestId.trim(),
          original_adjustment_id: input.originalAdjustmentId,
          adjustment_date: input.adjustmentDate,
          description: input.description,
          evidence_reference: input.evidenceReference?.trim() || null,
          created_by: input.createdBy,
        },
      }),
    );
  },
  async listVatAdjustments(filter: PeriodFilter): Promise<VatAdjustment[]> {
    return rawArray(
      await invoke('list_vat_adjustments', {
        input: periodFilterToRaw(filter),
      }),
    ).map(vatAdjustmentFromRaw);
  },
  async previewVatReturn(input: {
    dateFrom: string;
    dateTo: string;
    submissionType: VatSubmissionType;
    profileId?: string;
  }): Promise<VatReturnPreview> {
    return vatPreviewFromRaw(
      await invoke('preview_vat_return', {
        input: {
          date_from: input.dateFrom,
          date_to: input.dateTo,
          submission_type: input.submissionType,
          profile_id: input.profileId || null,
        },
      }),
    );
  },
  async exportVatReturnXml(input: {
    dateFrom: string;
    dateTo: string;
    submissionType: VatSubmissionType;
    profileId?: string;
    businessReferenceId: string;
    fileName?: string;
  }): Promise<VatReturnExport> {
    const exported = vatExportFromRaw(
      await invoke('export_vat_return_xml', {
        input: {
          date_from: input.dateFrom,
          date_to: input.dateTo,
          submission_type: input.submissionType,
          profile_id: input.profileId || null,
          business_reference_id: input.businessReferenceId,
          file_name: input.fileName?.trim() || null,
        },
      }),
    );
    await shareMobileExport(exported.filePath);
    return exported;
  },
  async listVatReturnExports(filter: PeriodFilter): Promise<VatReturnExport[]> {
    return rawArray(
      await invoke('list_vat_return_exports', {
        input: periodFilterToRaw(filter),
      }),
    ).map(vatExportFromRaw);
  },
  async getReminderSettings(): Promise<ReminderSettings> {
    const row = await invoke<RawRecord | null>('get_reminder_settings');
    return {
      enabled: boolValue(row?.enabled),
      senderName: stringValue(row?.sender_name),
      lastScanAt: stringValue(row?.last_scan_at),
    };
  },
  async installReminderCycle(requestId: string, senderName?: string) {
    const row = recordValue(
      await invoke<unknown>('install_reminder_cycle', {
        input: {
          request_id: requestId,
          sender_name: senderName || null,
        },
      }),
    );
    const settingsRow = recordValue(row.settings);
    return {
      settings: {
        enabled: boolValue(settingsRow.enabled),
        senderName: stringValue(settingsRow.sender_name),
        lastScanAt: stringValue(settingsRow.last_scan_at),
      } satisfies ReminderSettings,
      templates: rawArray(row.templates).map(reminderTemplateFromRaw),
      createdLevels: valueArray(row.created_levels).map(numberValue),
      skippedLevels: valueArray(row.skipped_levels).map(numberValue),
      idempotent: boolValue(row.idempotent),
    };
  },
  async updateReminderSettings(settings: ReminderSettings) {
    await invoke('update_reminder_settings', {
      input: {
        enabled: settings.enabled,
        sender_name: settings.senderName || null,
      },
    });
  },
  async listReminderTemplates(): Promise<ReminderTemplate[]> {
    return rawArray(await invoke<unknown>('list_reminder_templates')).map(
      reminderTemplateFromRaw,
    );
  },
  async upsertReminderTemplate(
    input: Omit<ReminderTemplate, 'id'> & { id?: string },
  ) {
    await invoke('upsert_reminder_template', {
      input: {
        id: input.id || null,
        level: input.level,
        name: input.name,
        subject: input.subject,
        body: input.body,
        days_after_due: input.daysAfterDue,
        payment_deadline_days: input.paymentDeadlineDays,
        active: input.active,
      },
    });
  },
  async deleteReminderTemplate(id: string) {
    await invoke('delete_reminder_template', { id });
  },
  async generateDueReminders(asOf?: string) {
    const result = await this.scanDueReminders(crypto.randomUUID(), asOf);
    return result.created;
  },
  async scanDueReminders(
    requestId: string,
    asOf?: string,
  ): Promise<ReminderScanResult> {
    return reminderScanResultFromRaw(
      await invoke<unknown>('scan_due_reminders', {
        input: { request_id: requestId, as_of: asOf || null },
      }),
    );
  },
  async listReminders(
    filter: {
      status?: ReminderStatus;
      invoiceId?: string;
      dateFrom?: string;
      dateTo?: string;
    } = {},
  ): Promise<Reminder[]> {
    return rawArray(
      await invoke<unknown>('list_reminders', {
        filter: {
          status: filter.status || null,
          invoice_id: filter.invoiceId || null,
          date_from: filter.dateFrom || null,
          date_to: filter.dateTo || null,
        },
      }),
      'reminders',
    ).map(reminderFromRaw);
  },
  async getReminderHistory(reminderId: string): Promise<ReminderHistory[]> {
    return rawArray(
      await invoke<unknown>('get_reminder_history', { reminderId }),
      'history',
    ).map((row) => ({
      id: stringValue(row.id),
      reminderId: stringValue(row.reminder_id),
      action: stringValue(row.action),
      occurredAt: stringValue(row.occurred_at),
      note: stringValue(row.note),
    }));
  },
  async previewReminderDelivery(
    id: string,
    preparedOn?: string,
  ): Promise<ReminderPreview> {
    return reminderPreviewFromRaw(
      await invoke<unknown>('preview_reminder_delivery', {
        input: { id, prepared_on: preparedOn || null },
      }),
    );
  },
  async markReminder(id: string, status: ReminderStatus, note?: string) {
    return reminderFromRaw(
      recordValue(
        await invoke<unknown>('mark_reminder', {
          input: { id, status, note: note || null },
        }),
      ),
    );
  },
  async recordReminderAction(input: {
    requestId: string;
    id: string;
    action: ReminderDeliveryAction;
    preparedOn?: string;
    previewSha256: string;
    note?: string;
  }): Promise<ReminderActionResult> {
    return reminderActionResultFromRaw(
      await invoke<unknown>('record_reminder_action', {
        input: {
          request_id: input.requestId,
          id: input.id,
          action: input.action,
          prepared_on: input.preparedOn || null,
          preview_sha256: input.previewSha256,
          note: input.note || null,
        },
      }),
    );
  },
  async listPayrollContributionDefinitions(
    asOf?: string,
  ): Promise<PayrollContributionDefinition[]> {
    return rawArray(
      await invoke<unknown>('list_payroll_contribution_definitions', {
        asOf: asOf || null,
      }),
    ).map(contributionFromRaw);
  },
  async getPayrollRegulatoryProfiles(): Promise<PayrollRegulatoryProfile[]> {
    return rawArray(
      await invoke<unknown>('get_payroll_regulatory_profiles'),
    ).map((row) => ({
      id: stringValue(row.id),
      label: stringValue(row.label),
      source: stringValue(row.source),
      effectiveFrom: stringValue(row.effective_from),
      effectiveTo: stringValue(row.effective_to),
      definitions: rawArray(row.definitions).map((definition) => {
        const normalized = contributionFromRaw(definition);
        return {
          code: normalized.code,
          label: normalized.label,
          category: normalized.category,
          side: normalized.side,
          calculationKind: normalized.calculationKind,
          rateBp: normalized.rateBp,
          fixedAmountCents: normalized.fixedAmountCents,
          annualCeilingCents: normalized.annualCeilingCents,
          basisKind: normalized.basisKind,
          lppComponent: normalized.lppComponent,
          lppEmployeeId: normalized.lppEmployeeId,
          source: normalized.source,
          effectiveFrom: normalized.effectiveFrom,
          effectiveTo: normalized.effectiveTo,
          active: normalized.active,
        };
      }),
      notIncluded: Array.isArray(row.not_included)
        ? (row.not_included.map(
            stringValue,
          ) as PayrollRegulatoryProfile['notIncluded'])
        : [],
    }));
  },
  async upsertPayrollContributionDefinition(
    input: Omit<PayrollContributionDefinition, 'id'> & { id?: string },
  ) {
    await invoke('upsert_payroll_contribution_definition', {
      input: payrollContributionDefinitionToRaw(input),
    });
  },
  async deletePayrollContributionDefinition(id: string) {
    await invoke('delete_payroll_contribution_definition', { id });
  },
  async calculatePayrollContributions(input: {
    employeeId: string;
    period: string;
    paymentDate: string;
    grossCents: number;
    items: PayrollContributionSelection[];
  }): Promise<PayrollCalculation> {
    const raw = await invoke<RawRecord>(
      'calculate_employee_payroll_contributions',
      {
        input: {
          employee_id: input.employeeId,
          period: input.period,
          payment_date: input.paymentDate || null,
          gross_cents: input.grossCents,
          items: input.items.map((item) => ({
            definition_id: item.definitionId,
            basis_cents: item.basisCents,
            year_to_date_basis_cents: item.yearToDateBasisCents,
          })),
        },
      },
    );
    const items = rawArray(raw.items).map(
      (row): CalculatedPayrollContribution => ({
        ...contributionFromRaw(row),
        originalBasisCents: numberValue(row.original_basis_cents),
        basisCents: numberValue(row.basis_cents),
        yearToDateBasisCents:
          row.year_to_date_basis_cents === null ||
          row.year_to_date_basis_cents === undefined
            ? null
            : numberValue(row.year_to_date_basis_cents),
        amountCents: numberValue(row.amount_cents),
        statutoryAnnualCeilingCents:
          row.statutory_annual_ceiling_cents === null ||
          row.statutory_annual_ceiling_cents === undefined
            ? null
            : numberValue(row.statutory_annual_ceiling_cents),
        acProrationDays:
          row.ac_proration_days_30_360 === null ||
          row.ac_proration_days_30_360 === undefined
            ? null
            : numberValue(row.ac_proration_days_30_360),
        acEmploymentFrom: stringValue(row.ac_employment_from),
        acEmploymentTo: stringValue(row.ac_employment_to),
        avsAllowanceAppliedCents:
          row.avs_allowance_applied_cents === null ||
          row.avs_allowance_applied_cents === undefined
            ? null
            : numberValue(row.avs_allowance_applied_cents),
        avsAllowanceWaived:
          row.avs_allowance_waived === null ||
          row.avs_allowance_waived === undefined
            ? null
            : boolValue(row.avs_allowance_waived),
      }),
    );
    return {
      period: stringValue(raw.period) || input.period,
      grossCents: numberValue(raw.gross_cents),
      employeeDeductionsCents: numberValue(raw.employee_deductions_cents),
      employerCostsCents: numberValue(raw.employer_costs_cents),
      items,
      smallSalaryAssessment: payrollSmallSalaryAssessmentFromRaw(
        raw.small_salary_assessment,
      ),
    };
  },
  async applyPayrollContributions(
    payslipId: string,
    period: string,
    items: PayrollContributionSelection[],
  ) {
    await invoke('apply_payroll_contributions', {
      input: {
        payslip_id: payslipId,
        period,
        items: items.map((item) => ({
          definition_id: item.definitionId,
          basis_cents: item.basisCents,
          year_to_date_basis_cents: item.yearToDateBasisCents,
        })),
      },
    });
    return loadWorkspace();
  },
  async getPayslipContributions(
    payslipId: string,
  ): Promise<PayslipContributionSnapshot[]> {
    return rawArray(
      await invoke<unknown>('get_payslip_contributions', { payslipId }),
    ).map(payslipContributionFromRaw);
  },
  async postPayslip(
    payslipId: string,
    entryDate?: string,
  ): Promise<PostPayslipResult> {
    const posted = await invoke<RawRecord>('post_payslip', {
      input: { payslip_id: payslipId, entry_date: entryDate || null },
    });
    const accountingFallbacks = accountingFallbacksFromPostPayslip(posted);
    try {
      return { workspace: await loadWorkspace(), accountingFallbacks };
    } catch (reason) {
      throw new PayslipPostingRefreshError(reason, accountingFallbacks);
    }
  },
  async payPayslip(
    payslipId: string,
    paymentDate: string,
    reference?: string,
    regulatoryOverrideReason?: string,
  ) {
    await invoke('pay_payslip', {
      input: {
        payslip_id: payslipId,
        payment_date: paymentDate || null,
        reference: reference?.trim() || null,
        regulatory_override_reason: regulatoryOverrideReason?.trim() || null,
      },
    });
    return refreshWorkspaceAfterMutation(loadWorkspace);
  },
  async exportPayslipPdf(
    payslipId: string,
    suggestedFileName: string,
  ): Promise<{ path: string; pages: number; finalDocument: boolean; deliveryWarning?: string } | null> {
    const selected = await chooseSaveFile({
      title: 'Enregistrer la fiche de salaire PDF',
      defaultPath: suggestedFileName,
      filters: [{ name: 'Document PDF', extensions: ['pdf'] }],
    });
    if (!selected) return null;
    const destinationPath = selected.toLowerCase().endsWith('.pdf')
      ? selected
      : `${selected}.pdf`;
    const raw = await invoke<RawRecord>('generate_payslip_pdf', {
      input: { payslip_id: payslipId, destination_path: destinationPath },
    });
    const result: { path: string; pages: number; finalDocument: boolean; deliveryWarning?: string } = {
      path: stringValue(raw.path),
      pages: numberValue(raw.pages),
      finalDocument: boolValue(raw.final_document),
    };
    try { await shareMobileExport(result.path); }
    catch { result.deliveryWarning = 'Le PDF a été créé, mais le partage n’a pas abouti. Utilisez « Partager le PDF » pour réessayer.'; }
    return result;
  },
  async exportSalesDocumentPdf(
    entity: SalesPdfEntity,
    documentId: string,
    suggestedFileName: string,
  ): Promise<{
    path: string;
    pages: number;
    finalDocument: boolean;
    hasQr: boolean;
    documentType: 'quote' | 'invoice' | 'credit_note';
  } | null> {
    const selected = await chooseSaveFile({
      title:
        entity === 'quotes'
          ? 'Enregistrer le devis PDF'
          : 'Enregistrer la facture PDF',
      defaultPath: suggestedFileName,
      filters: [{ name: 'Document PDF', extensions: ['pdf'] }],
    });
    if (!selected) return null;
    const destinationPath = pdfDestinationPath(selected);
    const raw = await invoke<RawRecord>(
      'generate_sales_document_pdf',
      salesPdfInvokeInput(entity, documentId, destinationPath),
    );
    await shareMobileExport(stringValue(raw.path));
    return {
      path: stringValue(raw.path),
      pages: numberValue(raw.pages),
      finalDocument: boolValue(raw.final_document),
      hasQr: boolValue(raw.has_qr),
      documentType: stringValue(raw.document_type) as
        | 'quote'
        | 'invoice'
        | 'credit_note',
    };
  },
  async saveInvoiceQrBill(
    invoiceId: string,
    bill: SwissQrBillInput,
  ): Promise<StoredSwissQrBill> {
    const raw = await invoke<RawRecord>('save_invoice_qr_bill', {
      input: { invoice_id: invoiceId, bill: qrInputToRaw(bill) },
    });
    const stored = storedQrBillFromRaw(raw, invoiceId);
    if (!stored)
      throw new Error(
        'La QR-facture validée n’a pas pu être relue après son enregistrement local.',
      );
    return stored;
  },
  async getInvoiceQrBill(invoiceId: string): Promise<StoredSwissQrBill | null> {
    const raw = await invoke<RawRecord | null>('get_invoice_qr_bill', {
      invoiceId,
    });
    return raw ? storedQrBillFromRaw(raw, invoiceId) : null;
  },
  async validateSwissQrBill(
    input: SwissQrBillInput,
  ): Promise<SwissQrValidation> {
    const raw = await invoke<RawRecord>('validate_swiss_qr_bill', {
      input: qrInputToRaw(input),
    });
    return {
      valid: boolValue(raw.valid),
      errors: Array.isArray(raw.errors) ? raw.errors.map(stringValue) : [],
      warnings: Array.isArray(raw.warnings)
        ? raw.warnings.map(stringValue)
        : [],
      normalized: qrInputFromRaw(raw.normalized as RawRecord),
      isQrIban: boolValue(raw.is_qr_iban),
    };
  },
  async generateSwissQrPayload(
    input: SwissQrBillInput,
  ): Promise<SwissQrPayload> {
    const raw = await invoke<RawRecord>('generate_swiss_qr_payload', {
      input: qrInputToRaw(input),
    });
    return {
      payload: stringValue(raw.payload),
      lines: Array.isArray(raw.lines) ? raw.lines.map(stringValue) : [],
      referenceType: stringValue(
        raw.reference_type,
      ) as SwissQrBillInput['referenceType'],
      isQrIban: boolValue(raw.is_qr_iban),
      characterCount: numberValue(raw.character_count),
      byteCount: numberValue(raw.byte_count),
    };
  },
  openDataFolder: () => invoke<string>('open_data_folder'),
};
