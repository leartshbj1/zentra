import { invoke } from '@tauri-apps/api/core';
import type {
  AppSettings,
  Client,
  DocumentLine,
  Employee,
  EntityKind,
  Expense,
  Invoice,
  OnboardingPayload,
  Payment,
  Payslip,
  Project,
  Quote,
  TimeEntry,
  Workspace,
} from './types';

type RawRecord = Record<string, unknown>;
type AppState = { onboarding_completed: boolean; data_dir: string; database_path: string; app_version: string };
type RawWorkspace = {
  settings?: RawRecord | null;
  clients?: RawRecord[];
  projects?: RawRecord[];
  quotes?: RawRecord[];
  quote_items?: RawRecord[];
  invoices?: RawRecord[];
  invoice_items?: RawRecord[];
  employees?: RawRecord[];
  time_entries?: RawRecord[];
  expenses?: RawRecord[];
  payslips?: RawRecord[];
  payslip_items?: RawRecord[];
  payments?: RawRecord[];
  active_timer?: RawRecord | null;
};

const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberValue = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const boolValue = (value: unknown): boolean => value === true || value === 1 || value === '1';

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

function settingsFromRaw(row: RawRecord | null | undefined): AppSettings | null {
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
      uidNumber: stringValue(row.uid_number) || stringValue(row.vat_number),
      vatRegistered: boolValue(row.vat_registered),
      address: {
        street: [stringValue(row.address_line1), stringValue(row.address_line2)].filter(Boolean).join('\n'),
        postalCode: stringValue(row.postal_code),
        city: stringValue(row.city),
        canton: stringValue(row.canton),
        country: stringValue(row.country),
      },
      logoPath: stringValue(row.logo_path) || undefined,
    },
    billing: {
      currency: 'CHF',
      iban: stringValue(row.iban),
      accountHolder: extraBilling?.accountHolder ?? stringValue(row.company_name),
      quotePrefix: stringValue(row.quote_prefix),
      invoicePrefix: stringValue(row.invoice_prefix),
      creditNotePrefix: extraBilling?.creditNotePrefix ?? '',
      nextQuoteNumber: extraBilling?.nextQuoteNumber ?? 1,
      nextInvoiceNumber: extraBilling?.nextInvoiceNumber ?? 1,
      nextCreditNoteNumber: extraBilling?.nextCreditNoteNumber ?? 1,
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

function normalizeWorkspace(raw: RawWorkspace, appState: AppState): Workspace {
  const quoteItems = raw.quote_items ?? [];
  const invoiceItems = raw.invoice_items ?? [];
  const payslipItems = raw.payslip_items ?? [];
  const clients: Client[] = (raw.clients ?? []).map((row) => ({
    id: stringValue(row.id), name: stringValue(row.contact_person) || stringValue(row.name), company: stringValue(row.company), email: stringValue(row.email), phone: stringValue(row.phone),
    address: [stringValue(row.address_line1), stringValue(row.address_line2), [stringValue(row.postal_code), stringValue(row.city)].filter(Boolean).join(' '), stringValue(row.canton), stringValue(row.country)].filter(Boolean).join('\n'),
    uidNumber: '', notes: stringValue(row.notes),
  }));
  const projects: Project[] = (raw.projects ?? []).map((row) => ({
    id: stringValue(row.id), clientId: stringValue(row.client_id), name: stringValue(row.name),
    address: [stringValue(row.address_line1), stringValue(row.address_line2), [stringValue(row.postal_code), stringValue(row.city)].filter(Boolean).join(' '), stringValue(row.canton)].filter(Boolean).join('\n'),
    status: projectStatusFromRaw(row.status), plannedStart: stringValue(row.planned_start_date), plannedEnd: stringValue(row.planned_end_date), actualStart: stringValue(row.actual_start_date), actualEnd: stringValue(row.actual_end_date), budgetCents: numberValue(row.budget_cents), plannedMinutes: numberValue(row.planned_minutes), notes: stringValue(row.notes) || stringValue(row.description),
  }));
  const quotes: Quote[] = (raw.quotes ?? []).map((row) => ({
    id: stringValue(row.id), number: stringValue(row.number), clientId: stringValue(row.client_id), projectId: stringValue(row.project_id) || null, title: stringValue(row.title), issueDate: stringValue(row.issue_date), validUntil: stringValue(row.valid_until), status: quoteStatusFromRaw(row.status),
    lines: quoteItems.filter((item) => stringValue(item.quote_id) === stringValue(row.id)).sort((a, b) => numberValue(a.position) - numberValue(b.position)).map(lineFromRaw), notes: stringValue(row.notes), createdAt: stringValue(row.created_at),
  }));
  const invoices: Invoice[] = (raw.invoices ?? []).map((row) => ({
    id: stringValue(row.id), number: stringValue(row.number), clientId: stringValue(row.client_id), projectId: stringValue(row.project_id) || null, quoteId: stringValue(row.quote_id) || null, title: stringValue(row.title),
    type: ({ acompte: 'deposit', situation: 'progress', finale: 'final', avoir: 'credit_note' } as Record<string, Invoice['type']>)[stringValue(row.type)] ?? 'standard', issueDate: stringValue(row.issue_date), dueDate: stringValue(row.due_date), status: invoiceStatusFromRaw(row.status),
    lines: invoiceItems.filter((item) => stringValue(item.invoice_id) === stringValue(row.id)).sort((a, b) => numberValue(a.position) - numberValue(b.position)).map(lineFromRaw), notes: stringValue(row.notes), createdAt: stringValue(row.created_at),
  }));
  const employees: Employee[] = (raw.employees ?? []).map((row) => ({
    id: stringValue(row.id), name: stringValue(row.name), role: stringValue(row.role), email: stringValue(row.email), phone: stringValue(row.phone),
    address: [stringValue(row.address_line1), stringValue(row.address_line2), [stringValue(row.postal_code), stringValue(row.city)].filter(Boolean).join(' '), stringValue(row.canton)].filter(Boolean).join('\n'),
    avsNumber: stringValue(row.social_security_number), employmentStart: stringValue(row.employment_start_date), employmentEnd: stringValue(row.employment_end_date), employmentRate: numberValue(row.employment_rate), salaryMode: numberValue(row.monthly_salary_cents) > 0 ? 'monthly' : 'hourly', grossSalaryCents: numberValue(row.monthly_salary_cents), hourlyCostCents: numberValue(row.hourly_rate_cents), iban: stringValue(row.iban), active: stringValue(row.status) !== 'inactif',
  }));
  const timeEntries: TimeEntry[] = (raw.time_entries ?? []).map((row) => ({ id: stringValue(row.id), projectId: stringValue(row.project_id), employeeId: stringValue(row.employee_id), date: stringValue(row.date), minutes: numberValue(row.minutes), hourlyCostCents: numberValue(row.cost_rate_cents), note: stringValue(row.note), status: ({ approuve: 'approved', verrouille: 'locked' } as Record<string, TimeEntry['status']>)[stringValue(row.status)] ?? 'entered', createdAt: stringValue(row.created_at) }));
  const expenses: Expense[] = (raw.expenses ?? []).map((row) => ({ id: stringValue(row.id), projectId: stringValue(row.project_id), date: stringValue(row.date), supplier: stringValue(row.supplier), category: stringValue(row.category), netCents: numberValue(row.net_cents), vatCents: numberValue(row.vat_cents), totalCents: numberValue(row.total_cents), note: stringValue(row.note) }));
  const payslips: Payslip[] = (raw.payslips ?? []).map((row) => ({
    id: stringValue(row.id), employeeId: stringValue(row.employee_id), period: stringValue(row.period), status: ({ brouillon: 'draft', valide: 'validated', paye: 'validated' } as Record<string, Payslip['status']>)[stringValue(row.status)] ?? 'incomplete',
    lines: payslipItems.filter((item) => stringValue(item.payslip_id) === stringValue(row.id)).sort((a, b) => numberValue(a.position) - numberValue(b.position)).map((item) => ({ id: stringValue(item.id), label: stringValue(item.label), kind: (['earning', 'deduction', 'employer'].includes(stringValue(item.kind)) ? stringValue(item.kind) : 'earning') as 'earning' | 'deduction' | 'employer', amountCents: numberValue(item.amount_cents) })), notes: stringValue(row.notes), createdAt: stringValue(row.created_at),
  }));
  const payments: Payment[] = (raw.payments ?? []).map((row) => ({ id: stringValue(row.id), invoiceId: stringValue(row.invoice_id), date: stringValue(row.date), amountCents: numberValue(row.amount_cents), method: stringValue(row.method), reference: stringValue(row.reference) }));
  const timer = raw.active_timer;
  return {
    schemaVersion: 1, onboardingCompleted: appState.onboarding_completed, settings: settingsFromRaw(raw.settings), clients, projects, quotes, invoices, payments, employees, timeEntries,
    activeTimer: timer ? { projectId: stringValue(timer.project_id), employeeId: stringValue(timer.employee_id), startedAt: stringValue(timer.started_at), note: stringValue(timer.note) } : null,
    expenses, payslips, backupStatus: { lastSuccessAt: null, lastPath: null, nextScheduledAt: null },
  };
}

function emptyWorkspace(): Workspace {
  return { schemaVersion: 1, onboardingCompleted: false, settings: null, clients: [], projects: [], quotes: [], invoices: [], payments: [], employees: [], timeEntries: [], activeTimer: null, expenses: [], payslips: [], backupStatus: { lastSuccessAt: null, lastPath: null, nextScheduledAt: null } };
}

async function loadWorkspace(): Promise<Workspace> {
  const appState = await invoke<AppState>('get_app_state');
  if (!appState.onboarding_completed) return emptyWorkspace();
  return normalizeWorkspace(await invoke<RawWorkspace>('get_workspace'), appState);
}

function backendExtra(settings: AppSettings): string {
  return JSON.stringify({ organization: { website: settings.organization.website }, billing: { accountHolder: settings.billing.accountHolder, creditNotePrefix: settings.billing.creditNotePrefix, nextQuoteNumber: settings.billing.nextQuoteNumber, nextInvoiceNumber: settings.billing.nextInvoiceNumber, nextCreditNoteNumber: settings.billing.nextCreditNoteNumber, quoteValidityDays: settings.billing.quoteValidityDays, vatRatesBp: settings.billing.vatRatesBp, defaultFooter: settings.billing.defaultFooter }, work: settings.work, payroll: settings.payroll, backup: settings.backup });
}

function settingsToBackend(settings: AppSettings): RawRecord {
  const street = settings.organization.address.street.split('\n');
  return {
    company_name: settings.organization.legalName, legal_form: settings.organization.legalForm, owner_name: settings.organization.contactName, email: settings.organization.email, phone: settings.organization.phone,
    address_line1: street[0] ?? '', address_line2: street.slice(1).join(' '), postal_code: settings.organization.address.postalCode, city: settings.organization.address.city, canton: settings.organization.address.canton, country: settings.organization.address.country,
    uid_number: settings.organization.uidNumber, vat_number: settings.organization.uidNumber, vat_registered: settings.organization.vatRegistered, default_vat_bp: settings.billing.vatRatesBp[0] ?? 0, iban: settings.billing.iban, bank_name: settings.billing.accountHolder, currency: 'CHF', quote_prefix: settings.billing.quotePrefix, invoice_prefix: settings.billing.invoicePrefix, payment_terms_days: settings.billing.paymentTermsDays, quote_validity_days: settings.billing.quoteValidityDays, default_hourly_rate_cents: 0, logo_path: settings.organization.logoPath ?? '', extra_settings_json: backendExtra(settings),
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
  let documentId = existing?.id;
  if (documentId) await invoke('update_record', { entity, id: documentId, data: toBackendData(data) });
  else documentId = stringValue((await createRecord(entity, toBackendData(data))).id);
  if (!documentId) throw new Error('Le document local n’a pas pu être identifié.');
  const itemEntity = entity === 'quotes' ? 'quote_items' : 'invoice_items';
  const relationKey = entity === 'quotes' ? 'quote_id' : 'invoice_id';
  const previousLines = existing?.lines ?? [];
  const retained = new Set(lines.filter((line) => previousLines.some((old) => old.id === line.id)).map((line) => line.id));
  for (const previous of previousLines) if (!retained.has(previous.id)) await invoke('delete_record', { entity: itemEntity, id: previous.id });
  for (const [position, line] of lines.entries()) {
    const lineData = { [relationKey]: documentId, position, description: line.description, quantity: line.quantity, unit: line.unit, unit_price_cents: line.unitPriceCents, discount_bp: 0, vat_bp: line.vatRateBp };
    if (previousLines.some((old) => old.id === line.id)) await invoke('update_record', { entity: itemEntity, id: line.id, data: lineData });
    else await createRecord(itemEntity, lineData);
  }
  return loadWorkspace();
}

async function chooseFile(options: Record<string, unknown>): Promise<string | null> {
  const dialog = await import('@tauri-apps/plugin-dialog');
  const result = await dialog.open(options);
  return typeof result === 'string' ? result : null;
}

export const desktopApi = {
  loadWorkspace,
  async completeOnboarding(settings: OnboardingPayload) {
    await invoke<AppState>('complete_onboarding', { input: settingsToBackend(settings) });
    await invoke('update_settings', { data: settingsToBackend(settings) });
    return loadWorkspace();
  },
  async saveSettings(settings: AppSettings) { await invoke('update_settings', { data: settingsToBackend(settings) }); return loadWorkspace(); },
  async createEntity<T extends Record<string, unknown>>(entity: EntityKind, data: T) { await createRecord(entityToBackend[entity], toBackendData(data)); return loadWorkspace(); },
  async updateEntity<T extends Record<string, unknown>>(entity: EntityKind, id: string, data: T) { await invoke('update_record', { entity: entityToBackend[entity], id, data: toBackendData(data) }); return loadWorkspace(); },
  async archiveEntity(entity: EntityKind, id: string) { await invoke('delete_record', { entity: entityToBackend[entity], id }); return loadWorkspace(); },
  saveDocument,
  async issueDocument(entity: 'quotes' | 'invoices', id: string, issueDate?: string, dueDate?: string) {
    if (entity === 'quotes') await invoke('issue_quote', { id, issueDate, validUntil: dueDate });
    else await invoke('issue_invoice', { id, issueDate, dueDate });
    return loadWorkspace();
  },
  async convertQuote(quote: Quote) {
    const created = await createRecord('invoices', { client_id: quote.clientId, project_id: quote.projectId, quote_id: quote.id, title: quote.title, type: 'standard', status: 'brouillon', issue_date: new Date().toISOString().slice(0, 10), due_date: '', currency: 'CHF', notes: quote.notes });
    const invoiceId = stringValue(created.id);
    for (const [position, line] of quote.lines.entries()) await createRecord('invoice_items', { invoice_id: invoiceId, position, description: line.description, quantity: line.quantity, unit: line.unit, unit_price_cents: line.unitPriceCents, discount_bp: 0, vat_bp: line.vatRateBp });
    return loadWorkspace();
  },
  async addPayment(invoiceId: string, data: Record<string, unknown>) { await invoke('record_payment', { input: { invoice_id: invoiceId, ...toBackendData(data) } }); return loadWorkspace(); },
  async savePayslip(data: Record<string, unknown>, lines: Array<{ id: string; label: string; kind: string; amountCents: number }>, existing?: Payslip) {
    let payslipId = existing?.id;
    if (payslipId) await invoke('update_record', { entity: 'payslips', id: payslipId, data: toBackendData(data) });
    else payslipId = stringValue((await createRecord('payslips', toBackendData(data))).id);
    if (!payslipId) throw new Error('La fiche de salaire locale n’a pas pu être identifiée.');
    const previous = existing?.lines ?? [];
    const retained = new Set(lines.filter((line) => previous.some((old) => old.id === line.id)).map((line) => line.id));
    for (const old of previous) if (!retained.has(old.id)) await invoke('delete_record', { entity: 'payslip_items', id: old.id });
    for (const [position, line] of lines.entries()) {
      const lineData = { payslip_id: payslipId, position, label: line.label, kind: line.kind, amount_cents: line.amountCents };
      if (previous.some((old) => old.id === line.id)) await invoke('update_record', { entity: 'payslip_items', id: line.id, data: lineData });
      else await createRecord('payslip_items', lineData);
    }
    return loadWorkspace();
  },
  async startTimer(data: Record<string, unknown>) { await invoke('start_timer', { input: toBackendData(data) }); return loadWorkspace(); },
  async stopTimer() { await invoke('stop_timer'); return loadWorkspace(); },
  async createBackup(destination?: string) { const path = await invoke<string>('create_backup', { destination }); return { workspace: await loadWorkspace(), path }; },
  chooseRestoreFile: () => chooseFile({ multiple: false, directory: false, title: 'Choisir une sauvegarde HelviChantier', filters: [{ name: 'Sauvegarde HelviChantier', extensions: ['hchantier', 'zip'] }] }),
  async restoreBackup(source: string) { await invoke<AppState>('restore_backup', { source }); return loadWorkspace(); },
  async exportData(format: 'json' | 'csv') { if (format !== 'json') throw new Error('L’export CSV sera disponible depuis chaque liste.'); return { path: await invoke<string>('export_json', {}) }; },
  async printDocument(entity: 'quotes' | 'invoices' | 'payslips', id: string) { window.print(); return { entity, id }; },
  chooseBackupFolder: () => chooseFile({ directory: true, multiple: false, title: 'Choisir le dossier de sauvegarde' }),
  chooseLogo: () => chooseFile({ multiple: false, directory: false, title: 'Choisir le logo', filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }),
  openDataFolder: () => invoke<string>('open_data_folder'),
};
