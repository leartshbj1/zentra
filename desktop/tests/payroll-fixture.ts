// Synthetic payroll RPCs for browser acceptance; native tests verify payroll accounting.
import { desktopApi } from '../src/bridge';
import { WorkspaceRefreshAfterMutationError } from '../src/workspaceMutation';
import { PayslipPostingRefreshError } from '../src/payrollMutation';
import type { Account, Employee, PayrollCalculation, PayrollContributionDefinition, PayslipContributionSnapshot, Payslip, Workspace } from '../src/types';

export function installPayrollFixture(workspace: Workspace) {
  if (!workspace.settings) throw new Error('Missing fixture settings');
  const regulation = 'Règlement LPP de recette 2026, article 12';
  workspace.settings.payroll = { ...workspace.settings.payroll, enabled: true, fiduciaryValidated: true, payrollCanton: 'VD', avsFund: 'Caisse de recette', accidentInsurer: 'Assureur LAA de recette', pensionFund: 'Fondation de recette', familyAllowanceFund: 'CAF de recette', lppPlanEvidence: { contractNumber: 'QA-LPP-2026', regulationReference: regulation, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', employerAggregateShareConfirmed: true } };
  function employee(id: string, name: string): Employee {
    return { id, name, employeeNumber: id, role: 'Responsable de projet', email: `${id}@example.invalid`, phone: '', address: '', addressLine1: '', addressLine2: '', postalCode: '1000', city: 'Lausanne', canton: 'VD', country: 'CH', birthDate: '1990-01-01', avsNumber: '', employmentStart: '2026-01-01', employmentEnd: '', employmentContractKind: 'indefinite', lppAssessmentYear: 2026, lppAnnualSalaryCents: 6000000, lppExceptionCode: null, lppExceptionEvidenceReference: '', referenceAgeDate: '', avsAllowanceWaived: null, smallSalaryAssessmentYear: 2026, smallSalarySector: 'ordinary', smallSalaryEmployeeRequestedContributions: false, smallSalaryDecisionDate: '2026-01-01', smallSalaryOpeningGrossCents: 0, smallSalaryOpeningContributedBasisCents: 0, smallSalaryEvidenceReference: 'Décision annuelle de recette 2026', employmentRate: 100, contractualWeeklyMinutes: 2400, acOpeningYear: 2026, acOpeningBasisCents: 0, laaOpeningYear: 2026, laaOpeningBasisCents: 0, salaryMode: 'monthly', grossSalaryCents: 500000, hourlyCostCents: 0, iban: '', active: true, notes: '' };
  }
  workspace.employees = [employee('elodie', 'Élodie Dubois'), employee('jean', 'Jean Martin')];
  workspace.payslips = Array.from({ length: 32 }, (_, index): Payslip => ({ id: `old-${index}`, employeeId: index % 2 ? 'jean' : 'elodie', period: `2025-${String(index % 12 + 1).padStart(2, '0')}`, status: 'incomplete', lines: [{ id: `old-line-${index}`, label: 'Salaire de recette', kind: 'earning', amountCents: 500000 }], paymentDate: '', notes: '', createdAt: `2025-${String(index % 12 + 1).padStart(2, '0')}-01T10:00:00Z` }));
  const accounts: Account[] = [
    { id: 'bank-qa', code: '1020', name: 'Banque', accountType: 'asset', normalBalance: 'debit', reportSection: 'current_assets', active: true },
    { id: 'social-qa', code: '2270', name: 'Cotisations à payer', accountType: 'liability', normalBalance: 'credit', reportSection: 'short_term_liabilities', active: true },
    { id: 'expense-qa', code: '5800', name: 'Frais de personnel', accountType: 'expense', normalBalance: 'debit', reportSection: 'personnel_expense', active: true },
  ];
  desktopApi.listAccounts = async () => accounts;
  const settings = desktopApi.getAccountingSettings;
  desktopApi.getAccountingSettings = async () => ({ ...await settings(), enabled: true });
  function definition(code: string, category: PayrollContributionDefinition['category'], side: 'employee' | 'employer', rateBp: number): PayrollContributionDefinition {
    return { id: code, code, label: code.replaceAll('_', ' '), category, side, calculationKind: 'rate', rateBp, fixedAmountCents: null, annualCeilingCents: ['ac', 'aap', 'aanp'].includes(category) ? 14820000 : null, basisKind: ['aap', 'aanp', 'family_allowance'].includes(category) ? 'ahv_salary' : 'gross', lppComponent: null, lppEmployeeId: null, source: 'Contrat et taux de recette, aucune donnée réelle', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', active: true, liabilityAccountId: 'social-qa', expenseAccountId: side === 'employer' ? 'expense-qa' : '' };
  }
  const definitions = [definition('AVS_EMPLOYEE', 'avs_ai_apg', 'employee', 435), definition('AVS_EMPLOYER', 'avs_ai_apg', 'employer', 435), definition('AI_EMPLOYEE', 'avs_ai_apg', 'employee', 70), definition('AI_EMPLOYER', 'avs_ai_apg', 'employer', 70), definition('APG_EMPLOYEE', 'avs_ai_apg', 'employee', 25), definition('APG_EMPLOYER', 'avs_ai_apg', 'employer', 25), definition('AC_EMPLOYEE', 'ac', 'employee', 110), definition('AC_EMPLOYER', 'ac', 'employer', 110), definition('AAP_TEST', 'aap', 'employer', 100), definition('AANP_TEST', 'aanp', 'employee', 100), definition('CAF_TEST', 'family_allowance', 'employer', 200)];
  for (const side of ['employee', 'employer'] as const) definitions.push({ ...definition(`LPP_${side.toUpperCase()}`, 'lpp', side, 0), calculationKind: 'fixed', rateBp: null, fixedAmountCents: 25000, basisKind: 'coordinated', lppComponent: 'combined', lppEmployeeId: 'elodie', source: regulation });
  const snapshots = new Map<string, PayslipContributionSnapshot[]>();
  const counter = (name: string, input: unknown) => {
    const key = `qa-payroll-${name}`; const rows = JSON.parse(sessionStorage.getItem(key) || '[]'); rows.push(input); sessionStorage.setItem(key, JSON.stringify(rows)); return rows.length;
  };
  async function hold(name: string) {
    if (sessionStorage.getItem(`qa-payroll-hold-${name}`) !== '1') return;
    sessionStorage.setItem(`qa-payroll-waiting-${name}`, '1');
    await new Promise<void>((resolve) => { const timer = setInterval(() => { if (sessionStorage.getItem(`qa-payroll-hold-${name}`) === '1') return; clearInterval(timer); sessionStorage.removeItem(`qa-payroll-waiting-${name}`); resolve(); }, 30); });
  }
  desktopApi.loadWorkspace = async () => {
    counter('reads', {});
    if (sessionStorage.getItem('qa-payroll-fail-reads') === '1') throw new Error('Lecture des données momentanément indisponible.');
    return structuredClone(workspace);
  };
  async function afterWrite(name: string) {
    await hold(name);
    if (sessionStorage.getItem(`qa-payroll-recover-${name}`) === '1') {
      sessionStorage.setItem('qa-payroll-fail-reads', '1');
      throw new WorkspaceRefreshAfterMutationError(new Error('Lecture après enregistrement interrompue.'));
    }
    return desktopApi.loadWorkspace();
  }
  desktopApi.listPayrollContributionDefinitions = async () => {
    if (sessionStorage.getItem('qa-payroll-fail-rates') === '1') throw new Error('Les paramètres de cotisation sont momentanément indisponibles.');
    return structuredClone(definitions);
  };
  desktopApi.getPayslipContributions = async (id) => structuredClone(snapshots.get(id) || []);
  desktopApi.calculatePayrollContributions = async (input) => {
    const attempt = counter('calculate', input);
    const result: PayrollCalculation = { period: input.period, grossCents: input.grossCents, employeeDeductionsCents: 0, employerCostsCents: 0, smallSalaryAssessment: null, items: input.items.map((selection) => {
      const definition = definitions.find((item) => item.id === selection.definitionId)!;
      const basisCents = definition.basisKind === 'gross' ? input.grossCents : selection.basisCents || 0;
      return { ...definition, basisCents, originalBasisCents: basisCents, yearToDateBasisCents: 0, amountCents: definition.fixedAmountCents ?? Math.round(basisCents * (definition.rateBp || 0) / 10000), statutoryAnnualCeilingCents: definition.annualCeilingCents, acProrationDays: null, acEmploymentFrom: '', acEmploymentTo: '', avsAllowanceAppliedCents: null, avsAllowanceWaived: null };
    }) };
    result.employeeDeductionsCents = result.items.filter((item) => item.side === 'employee').reduce((sum, item) => sum + item.amountCents, 0);
    result.employerCostsCents = result.items.filter((item) => item.side === 'employer').reduce((sum, item) => sum + item.amountCents, 0);
    await hold(`calculate-${attempt}`);
    return result;
  };
  desktopApi.savePayslipWithContributions = async (data, lines, existing, period, selections) => {
    counter('save', { data, lines, existingId: existing?.id, period, selections });
    if (sessionStorage.getItem('qa-payroll-refuse-save') === '1') throw new Error('Le compte des salaires à payer est inactif. Aucune fiche enregistrée.');
    const id = existing?.id || crypto.randomUUID();
    const gross = lines.filter((line) => line.kind === 'earning').reduce((sum, line) => sum + line.amountCents, 0);
    const calculated = await desktopApi.calculatePayrollContributions({ employeeId: String(data.employeeId), period, paymentDate: String(data.paymentDate || ''), grossCents: gross, items: selections });
    const generated = calculated.items.map((item) => ({ id: `${id}-${item.id}`, label: item.label, kind: item.side === 'employee' ? 'deduction' as const : 'employer' as const, amountCents: item.amountCents, postingAccountId: item.liabilityAccountId, expenseAccountId: item.expenseAccountId }));
    const saved: Payslip = { id, employeeId: String(data.employeeId), period, status: data.status as Payslip['status'], lines: [...structuredClone(lines), ...generated], paymentDate: String(data.paymentDate || ''), notes: String(data.notes || ''), createdAt: new Date().toISOString() };
    snapshots.set(id, calculated.items.map((item, index) => ({ ...item, id: `snapshot-${id}-${index}`, definitionId: item.id, payslipId: id, payslipItemId: generated[index].id, createdAt: '' })));
    workspace.payslips = [saved, ...workspace.payslips.filter((item) => item.id !== id)];
    sessionStorage.setItem('qa-payroll-saved-id', id);
    return afterWrite('save');
  };
  desktopApi.postPayslip = async (id) => {
    counter('post', { id });
    const item = workspace.payslips.find((item) => item.id === id)!; item.status = 'posted';
    item.snapshot = { capturedAt: new Date().toISOString(), contributionDate: item.paymentDate || `${item.period}-01`, period: item.period, paymentDate: item.paymentDate, notes: item.notes, employee: workspace.employees.find((employee) => employee.id === item.employeeId)!, items: structuredClone(item.lines), contributions: structuredClone(snapshots.get(id) || []), issuer: { companyName: 'Atelier de recette', legalForm: '', ownerName: '', email: '', phone: '', addressLine1: 'Rue de recette', addressLine2: '', buildingNumber: '1', postalCode: '1000', city: 'Lausanne', canton: 'VD', country: 'CH', uidNumber: '', vatNumber: '', vatRegistered: false, iban: '', bankName: '', currency: 'CHF', logoPath: '' } };
    const accountingFallbacks = [{ contribution: 'AVS employé', field: 'liability_account_id', accountId: 'social-qa', reason: 'Compte général utilisé dans la recette' }];
    try { return { workspace: await afterWrite('post'), accountingFallbacks }; }
    catch (reason) { if (reason instanceof WorkspaceRefreshAfterMutationError) throw new PayslipPostingRefreshError(reason, accountingFallbacks); throw reason; }
  };
  desktopApi.payPayslip = async (id, paymentDate, reference) => {
    counter('pay', { id, paymentDate, reference });
    if (sessionStorage.getItem('qa-payroll-refuse-pay') === '1') throw new Error('Le compte bancaire est inactif. Aucun paiement enregistré.');
    const item = workspace.payslips.find((item) => item.id === id)!;
    item.status = 'paid'; item.paymentDate = paymentDate; item.paymentReference = reference; item.paymentJournalEntryId = 'paid-journal';
    return afterWrite('pay');
  };
  desktopApi.createEntity = async (entity, data) => {
    if (entity !== 'employees') throw new Error('Recette limitée aux collaborateurs.');
    counter('employee', data);
    if (sessionStorage.getItem('qa-payroll-refuse-employee') === '1') throw new Error('Le numéro de collaborateur existe déjà.');
    workspace.employees.push({ ...employee(crypto.randomUUID(), String(data.name)), ...data, grossSalaryCents: Number(data.monthlySalaryCents || 0), hourlyCostCents: Number(data.hourlyRateCents || 0), active: data.status === 'actif' });
    return afterWrite('employee');
  };
  desktopApi.exportPayslipPdf = async (id, name) => {
    counter('pdf', { id, name });
    if (sessionStorage.getItem('qa-payroll-refuse-pdf') === '1') throw new Error('Le dossier de destination est momentanément inaccessible.');
    return { path: `C:\\Recette\\${name}`, pages: 2, finalDocument: true, deliveryWarning: 'Le PDF a été créé, mais le partage n’a pas abouti. Utilisez « Partager le PDF » pour réessayer.' };
  };
  desktopApi.shareExistingExport = async (path) => {
    counter('share-pdf', { path });
    if (sessionStorage.getItem('qa-payroll-refuse-share') === '1') throw new Error('Le partage est momentanément indisponible.');
  };
}
