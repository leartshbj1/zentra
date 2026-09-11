import { useAssistantScreen } from './assistantContext';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { PayrollSetup } from './PayrollSetup';
import { PayrollProblem } from './PayrollProblem';
import { PayrollPreparation } from './PayrollPreparation';
import { payrollPreparationTasks } from './payrollPreparationTasks';
import { usePayrollFieldGuide } from './PayrollFieldGuide';
import { revealPayrollField } from './payrollNavigation';
import type { PayrollHelpTarget } from './payrollHelp';
import {
  PAYROLL_STEPS,
  PAYROLL_BASIS_LABELS,
  recurringSalary,
  suggestPayrollDefinitions,
  SOURCE_TAX_TARIFFS,
  guidedAhvBasis,
} from './payrollGuidance';
import {
  familyAllowanceReferenceForCanton,
  SWISS_FAMILY_ALLOWANCES_2026,
  SWISS_FAMILY_ALLOWANCES_2026_SOURCE,
} from './swissFamilyAllowances2026';
import './payroll-guided.css';
import {
  isPayrollCalculationCurrent,
  payrollCalculationFingerprint,
} from './payrollCalculationFingerprint';
import { assessSwissPayrollEligibility } from './payrollEligibility';
import {
  smallSalaryReasonLabel,
  smallSalarySectorLabel,
  recordedSmallSalaryGrossBeforePeriod,
} from './smallSalaryAssessment';
import type {
  Account,
  PayrollCalculation,
  PayrollContributionDefinition,
  PayrollContributionSelection,
  Payslip,
  PayslipLine,
  Workspace,
} from './types';
import { createId, errorMessage, formatMoney, payslipTotals } from './utils';
import { Button, Field, FormActions, Modal, submitForm } from './ui';

type ActionRunner = (
  action: () => Promise<Workspace>,
  message: string,
  close?: boolean,
  onError?: (reason: unknown) => void,
) => Promise<boolean>;
type SelectionDraft = { basisCents?: number; yearToDateBasisCents?: number };

function matchesSharedStatutoryCategory(
  category: PayrollContributionDefinition['category'],
): category is 'avs_ai_apg' | 'ac' {
  return category === 'avs_ai_apg' || category === 'ac';
}

export function DetailedPayslipForm({
  item,
  workspace,
  busy,
  close,
  act,
  initialEmployeeId,
  initialPeriod,
  initialPaymentDate,
  onAddEmployee,
}: {
  item?: Payslip;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
  initialEmployeeId?: string;
  initialPeriod?: string;
  initialPaymentDate?: string;
  onAddEmployee?: (period: string, paymentDate: string) => void;
}) {
  const activeEmployees = workspace.employees.filter(
    (employee) => employee.active,
  );
  const initialEmployee = !item
    ? (activeEmployees.find((employee) => employee.id === initialEmployeeId) ??
      (activeEmployees.length === 1 ? activeEmployees[0] : undefined))
    : undefined;
  const [step, setStep] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [setup, setSetup] = useState<PayrollHelpTarget | null>(null);
  const [setupSelector, setSetupSelector] = useState<string | undefined>();
  const [arrivalSelector, setArrivalSelector] = useState<string | undefined>();
  const [arrivalRevision, setArrivalRevision] = useState(0);
  const [configurationUpdated, setConfigurationUpdated] = useState(false);
  const fieldGuide = usePayrollFieldGuide();
  function fixPayroll(target: PayrollHelpTarget, selector?: string) {
    if (['salary', 'review', 'period'].includes(target)) setPreparing(false);
    setArrivalSelector(
      selector ??
        (target === 'salary' ? '[data-payroll-selection]' : undefined),
    );
    setArrivalRevision((value) => value + 1);
    setSetupSelector(selector);
    if (target === 'salary') {
      setStep(1);
      setShowContributions(true);
    } else if (target === 'review') setStep(2);
    else if (target === 'period') setStep(0);
    else setSetup(target);
  }
  const [showContributions, setShowContributions] = useState(false);
  const [automaticBases, setAutomaticBases] = useState<Set<string>>(new Set());
  const [referenceCanton, setReferenceCanton] = useState(
    workspace.settings?.payroll.payrollCanton ?? '',
  );
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<PayslipLine[]>(
    item?.lines.map((line) => ({ ...line })) ??
      recurringSalary(
        initialEmployee,
        workspace.employeePayrollTemplates.find(
          (template) => template.employeeId === initialEmployee?.id,
        ),
      ).map((line) => ({ ...line, id: createId(), kind: 'earning' as const })),
  );
  const [definitions, setDefinitions] = useState<
    PayrollContributionDefinition[]
  >([]);
  const [accountingAccounts, setAccountingAccounts] = useState<Account[]>([]);
  const [accountingEnabled, setAccountingEnabled] = useState<boolean | null>(
    null,
  );
  const [loadingAccounting, setLoadingAccounting] = useState(true);
  const [selectionDrafts, setSelections] = useState<
    Record<string, SelectionDraft>
  >({});
  const [calculation, setCalculation] = useState<PayrollCalculation | null>(
    null,
  );
  const [calculatedFingerprint, setCalculatedFingerprint] = useState<
    string | null
  >(null);
  const [calculationError, setCalculationError] = useState('');
  const [period, setPeriod] = useState(
    item?.period ??
      initialPeriod ??
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
  );
  const [employeeId, setEmployeeId] = useState(
    item?.employeeId ?? initialEmployee?.id ?? '',
  );
  const [paymentDate, setPaymentDate] = useState(
    item?.paymentDate ?? initialPaymentDate ?? '',
  );
  const [loadingRates, setLoadingRates] = useState(true);
  const [existingBlocked, setExistingBlocked] = useState(false);
  const [localError, setLocalError] = useState('');
  const [accountingError, setAccountingError] = useState('');
  const [ratesError, setRatesError] = useState('');
  const [configurationReload, setConfigurationReload] = useState(0);
  const [calculating, setCalculating] = useState(false);
  const calculationRequest = useRef(0);
  const automaticProposalApplied = useRef(false);
  const hydratedPayslipIdRef = useRef<string | null>(null);
  const totals = payslipTotals({
    id: item?.id ?? '',
    employeeId,
    period,
    status: item?.status ?? 'incomplete',
    lines,
    paymentDate,
    notes: item?.notes ?? '',
    createdAt: item?.createdAt ?? '',
  });
  const employee = workspace.employees.find(
    (candidate) => candidate.id === employeeId,
  );
  const primaryLine = lines.find((line) => line.kind === 'earning');
  const guidedBasis = guidedAhvBasis(lines);
  const cantonReference = familyAllowanceReferenceForCanton(referenceCanton);
  const recordedGrossBeforePeriodCents = useMemo(() => {
    return recordedSmallSalaryGrossBeforePeriod({
      payslips: workspace.payslips,
      employeeId,
      period,
      excludedPayslipId: item?.id,
    });
  }, [employeeId, item?.id, period, workspace.payslips]);
  const proposal = useMemo(
    () =>
      suggestPayrollDefinitions({
        employee,
        settings: workspace.settings!,
        period,
        contributionDate: paymentDate || `${period}-01`,
        definitions,
        ahvSalaryCents: guidedBasis.amountCents,
        recordedGrossBeforePeriodCents,
      }),
    [
      employee,
      workspace.settings,
      period,
      paymentDate,
      definitions,
      guidedBasis.amountCents,
      recordedGrossBeforePeriodCents,
    ],
  );

  useEffect(() => {
    if (setup || preparing) return;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current
      ?.closest('.modal__body')
      ?.scrollTo({ top: 0, behavior: 'instant' });
    if (arrivalSelector) revealPayrollField(formRef.current, arrivalSelector);
  }, [step, setup, preparing, arrivalSelector, arrivalRevision]);

  const selections = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(selectionDrafts).map(([id, selected]) => [
          id,
          automaticBases.has(id)
            ? { ...selected, basisCents: guidedBasis.amountCents }
            : selected,
        ]),
      ),
    [selectionDrafts, automaticBases, guidedBasis.amountCents, definitions],
  );

  useEffect(() => {
    let active = true;
    setLoadingAccounting(true);
    setAccountingError('');
    void Promise.all([
      desktopApi.listAccounts(),
      desktopApi.getAccountingSettings(),
    ])
      .then(([accounts, settings]) => {
        if (!active) return;
        setAccountingAccounts(accounts.filter((account) => account.active));
        setAccountingEnabled(settings.enabled);
      })
      .catch((reason) => {
        if (!active) return;
        setAccountingEnabled(null);
        setAccountingError(
          errorMessage(
            reason,
            'Les comptes de liaison de la paie n’ont pas pu être chargés.',
          ),
        );
      })
      .finally(() => {
        if (active) setLoadingAccounting(false);
      });
    return () => {
      active = false;
    };
  }, [configurationReload]);

  useEffect(() => {
    let active = true;
    setLoadingRates(true);
    setRatesError('');
    const contributionDate =
      paymentDate || (period ? `${period}-01` : undefined);
    void Promise.all([
      desktopApi.listPayrollContributionDefinitions(contributionDate),
      item ? desktopApi.getPayslipContributions(item.id) : Promise.resolve([]),
    ])
      .then(([items, snapshots]) => {
        if (!active) return;
        const available = items.filter((definition) => definition.active);
        const linkedItems = new Set(
          snapshots.map((snapshot) => snapshot.payslipItemId),
        );
        const restoresOriginalContext = Boolean(
          item && period === item.period && paymentDate === item.paymentDate,
        );
        const periodSnapshots = restoresOriginalContext ? snapshots : [];
        const missing = periodSnapshots.filter(
          (snapshot) =>
            !available.some(
              (definition) => definition.id === snapshot.definitionId,
            ),
        );
        setDefinitions(available);
        const hydrateItem = item && hydratedPayslipIdRef.current !== item.id;
        if (hydrateItem) {
          setLines(
            item.lines
              .filter((line) => !linkedItems.has(line.id))
              .map((line) => ({ ...line })),
          );
          hydratedPayslipIdRef.current = item.id;
        }
        setSelections((current) =>
          hydrateItem
            ? Object.fromEntries(
                periodSnapshots.map((snapshot) => [
                  snapshot.definitionId,
                  {
                    basisCents: snapshot.basisCents,
                    yearToDateBasisCents:
                      snapshot.yearToDateBasisCents ?? undefined,
                  },
                ]),
              )
            : Object.fromEntries(
                Object.entries(current).filter(([id]) =>
                  available.some((definition) => definition.id === id),
                ),
              ),
        );
        setExistingBlocked(missing.length > 0);
        invalidateCalculation();
        if (missing.length)
          setRatesError(
            `Réactivez les définitions suivantes avant de modifier cette fiche : ${missing.map((snapshot) => snapshot.label).join(', ')}.`,
          );
      })
      .catch((reason) => {
        if (!active) return;
        setExistingBlocked(true);
        setRatesError(
          errorMessage(
            reason,
            'Les cotisations de la fiche n’ont pas pu être chargées.',
          ),
        );
      })
      .finally(() => {
        if (active) setLoadingRates(false);
      });
    return () => {
      active = false;
    };
  }, [item, paymentDate, period, configurationReload]);

  useEffect(
    () => () => {
      calculationRequest.current += 1;
    },
    [],
  );

  const selectedItems = useMemo<PayrollContributionSelection[]>(
    () =>
      Object.entries(selections).map(([definitionId, values]) => ({
        definitionId,
        ...values,
      })),
    [selections],
  );
  const usesGuidedBasis = automaticBases.size > 0;
  const currentCalculationFingerprint = useMemo(
    () =>
      payrollCalculationFingerprint({
        employeeId,
        period,
        paymentDate,
        lines,
        selections: selectedItems,
      }),
    [employeeId, lines, paymentDate, period, selectedItems],
  );
  const currentFingerprintRef = useRef(currentCalculationFingerprint);
  const previousFingerprintRef = useRef(currentCalculationFingerprint);
  const inputRevisionRef = useRef(0);
  currentFingerprintRef.current = currentCalculationFingerprint;
  const hasCurrentCalculation =
    calculation !== null &&
    isPayrollCalculationCurrent(
      calculatedFingerprint,
      currentCalculationFingerprint,
    );

  useEffect(() => {
    if (previousFingerprintRef.current === currentCalculationFingerprint)
      return;
    previousFingerprintRef.current = currentCalculationFingerprint;
    inputRevisionRef.current += 1;
    calculationRequest.current += 1;
    setCalculating(false);
    setCalculation(null);
    setCalculatedFingerprint(null);
    setCalculationError('');
  }, [currentCalculationFingerprint]);
  const eligibility = useMemo(
    () =>
      assessSwissPayrollEligibility({
        employee: workspace.employees.find(
          (employee) => employee.id === employeeId,
        ),
        settings: workspace.settings!,
        period,
        contributionDate: paymentDate || (period ? `${period}-01` : ''),
        grossCents: totals.earnings - guidedBasis.familyAllowanceCents,
        recordedGrossBeforePeriodCents,
        definitions,
        selectedIds: new Set(Object.keys(selections)),
      }),
    [
      definitions,
      employeeId,
      paymentDate,
      period,
      selections,
      totals.earnings,
      guidedBasis.familyAllowanceCents,
      recordedGrossBeforePeriodCents,
      workspace.employees,
      workspace.settings,
    ],
  );

  useAssistantScreen(
    {
      screen: 'Création de fiche de salaire',
      scope: `paie:${employeeId}:${period}`,
      facts: {
        Étape: [
          'Collaborateur et période',
          'Salaire et cotisations',
          'Vérification',
        ][step],
        Période: period,
        'Canton de paie': referenceCanton,
        'Collaborateur sélectionné': Boolean(employee),
        'Salaire brut saisi (CHF)': (totals.earnings / 100).toFixed(2),
        'Calcul à jour': hasCurrentCalculation,
        'Points bloquants': eligibility.blockers.join(' ; ').slice(0, 700),
        'Points à vérifier': eligibility.warnings.join(' ; ').slice(0, 500),
        'Erreur affichée': [
          localError,
          calculationError,
          ratesError,
          accountingError,
        ]
          .filter(Boolean)
          .join(' ; ')
          .slice(0, 600),
      },
      actions: [
        { label: 'Vérifier le collaborateur', run: () => fixPayroll('person') },
        {
          label: 'Vérifier les assurances',
          run: () => fixPayroll('insurance'),
        },
        {
          label: 'Vérifier le plan LPP',
          run: () => fixPayroll('pension-plan'),
        },
        { label: 'Revenir au salaire', run: () => fixPayroll('salary') },
      ],
    },
    30,
  );

  useEffect(() => {
    const coordinatedIds = definitions
      .filter(
        (definition) =>
          definition.category === 'lpp' &&
          definition.basisKind === 'coordinated',
      )
      .map((definition) => definition.id);
    if (!coordinatedIds.length) return;
    const expected = eligibility.coordinatedAnnualSalaryCents ?? undefined;
    setSelections((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of coordinatedIds) {
        if (next[id] && next[id].basisCents !== expected) {
          next[id] = { ...next[id], basisCents: expected };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [definitions, eligibility.coordinatedAnnualSalaryCents]);

  useEffect(() => {
    const grossDefinitionIds = new Set(
      definitions
        .filter((definition) => definition.basisKind === 'gross')
        .map((definition) => definition.id),
    );
    if (!grossDefinitionIds.size) return;
    setSelections((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of grossDefinitionIds) {
        if (next[id] && next[id].basisCents !== totals.earnings) {
          next[id] = { ...next[id], basisCents: totals.earnings };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [definitions, totals.earnings]);

  function invalidateCalculation() {
    inputRevisionRef.current += 1;
    calculationRequest.current += 1;
    setCalculating(false);
    setCalculation(null);
    setCalculatedFingerprint(null);
    setCalculationError('');
  }

  function addLine(kind: PayslipLine['kind']) {
    setLines((current) => [
      ...current,
      {
        id: createId(),
        label: '',
        kind,
        amountCents: 0,
      },
    ]);
    invalidateCalculation();
  }
  function updateLine(id: string, patch: Partial<PayslipLine>) {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
    invalidateCalculation();
  }

  function changeLineKind(id: string, value: string) {
    const kind = value as PayslipLine['kind'];
    setLines((current) =>
      current.map((line) =>
        line.id === id
          ? {
              ...line,
              kind,
              postingAccountId:
                kind === 'deduction' || kind === 'employer'
                  ? line.postingAccountId
                  : undefined,
              expenseAccountId:
                kind === 'reimbursement' || kind === 'employer'
                  ? line.expenseAccountId
                  : undefined,
            }
          : line,
      ),
    );
    invalidateCalculation();
  }

  function toggleDefinition(
    definition: PayrollContributionDefinition,
    checked: boolean,
  ) {
    invalidateCalculation();
    setSelections((current) => {
      if (!checked) {
        const next = { ...current };
        delete next[definition.id];
        return next;
      }
      const shared = definitions.find(
        (candidate) =>
          candidate.category === definition.category && current[candidate.id],
      );
      const sharesStatutoryBasis = matchesSharedStatutoryCategory(
        definition.category,
      );
      const groupUsesGross =
        sharesStatutoryBasis &&
        (definition.basisKind === 'gross' ||
          definitions.some(
            (candidate) =>
              candidate.category === definition.category &&
              candidate.basisKind === 'gross' &&
              current[candidate.id],
          ));
      const basisCents =
        definition.category === 'lpp' && definition.basisKind === 'coordinated'
          ? (eligibility.coordinatedAnnualSalaryCents ?? undefined)
          : groupUsesGross
            ? totals.earnings
            : sharesStatutoryBasis && shared
              ? current[shared.id].basisCents
              : definition.basisKind === 'gross'
                ? totals.earnings
                : undefined;
      const next = {
        ...current,
        [definition.id]: {
          basisCents,
          yearToDateBasisCents:
            definition.category === 'ac' && shared
              ? current[shared.id].yearToDateBasisCents
              : undefined,
        },
      };
      if (sharesStatutoryBasis && groupUsesGross) {
        for (const candidate of definitions) {
          if (
            candidate.category === definition.category &&
            next[candidate.id]
          ) {
            next[candidate.id] = {
              ...next[candidate.id],
              basisCents: totals.earnings,
            };
          }
        }
      }
      return next;
    });
  }

  function patchSelection(id: string, patch: SelectionDraft) {
    const definition = definitions.find((candidate) => candidate.id === id);
    if (!definition) return;
    if (
      (definition.basisKind === 'gross' ||
        (definition.category === 'lpp' &&
          definition.basisKind === 'coordinated')) &&
      Object.prototype.hasOwnProperty.call(patch, 'basisCents')
    )
      return;
    if (Object.prototype.hasOwnProperty.call(patch, 'basisCents')) {
      const related = new Set(
        definitions
          .filter(
            (candidate) =>
              candidate.id === id ||
              (matchesSharedStatutoryCategory(definition.category) &&
                candidate.category === definition.category),
          )
          .map((candidate) => candidate.id),
      );
      setAutomaticBases(
        (current) =>
          new Set([...current].filter((value) => !related.has(value))),
      );
    }
    invalidateCalculation();
    setSelections((current) => {
      if (!matchesSharedStatutoryCategory(definition.category)) {
        return {
          ...current,
          [id]: { ...current[id], ...patch },
        };
      }
      const groupUsesGross = definitions.some(
        (candidate) =>
          candidate.category === definition.category &&
          candidate.basisKind === 'gross' &&
          current[candidate.id],
      );
      const sharedPatch = { ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, 'basisCents')) {
        sharedPatch.basisCents = groupUsesGross
          ? totals.earnings
          : patch.basisCents;
      }
      if (
        definition.category !== 'ac' &&
        Object.prototype.hasOwnProperty.call(
          sharedPatch,
          'yearToDateBasisCents',
        )
      ) {
        delete sharedPatch.yearToDateBasisCents;
      }
      const next = { ...current };
      for (const candidate of definitions) {
        if (
          candidate.category === definition.category &&
          current[candidate.id]
        ) {
          next[candidate.id] = {
            ...current[candidate.id],
            ...sharedPatch,
          };
        }
      }
      return next;
    });
  }

  function selectEmployee(id: string) {
    if (id === employeeId) return;
    automaticProposalApplied.current = false;
    setSelections({});
    setAutomaticBases(new Set());
    invalidateCalculation();
    setEmployeeId(id);
    // Never carry another employee's salary or manual deductions into a new slip.
    if (item) return;
    const nextEmployee = workspace.employees.find(
      (candidate) => candidate.id === id,
    );
    const template = workspace.employeePayrollTemplates.find(
      (candidate) => candidate.employeeId === id,
    );
    setLines(
      recurringSalary(nextEmployee, template).map((line) => ({
        ...line,
        id: createId(),
        kind: 'earning',
      })),
    );
  }

  function applyProposal() {
    invalidateCalculation();
    const next: Record<string, SelectionDraft> = {};
    const automatic = new Set<string>();
    for (const definition of proposal) {
      const basisCents =
        definition.basisKind === 'coordinated'
          ? (eligibility.coordinatedAnnualSalaryCents ?? undefined)
          : definition.basisKind === 'gross'
            ? totals.earnings
            : definition.basisKind === 'ahv_salary'
              ? guidedBasis.amountCents
              : undefined;
      if (definition.basisKind === 'ahv_salary') automatic.add(definition.id);
      next[definition.id] = { basisCents };
    }
    setAutomaticBases(automatic);
    setSelections(next);
  }

  const missingProposals = proposal.filter(
    (definition) => !selections[definition.id],
  );
  function addMissingProposals() {
    // An explicit action adds the new applicable lines without resetting manual bases.
    invalidateCalculation();
    const next = { ...selectionDrafts };
    const automatic = new Set(automaticBases);
    for (const definition of missingProposals) {
      next[definition.id] = {
        basisCents:
          definition.basisKind === 'coordinated'
            ? (eligibility.coordinatedAnnualSalaryCents ?? undefined)
            : definition.basisKind === 'gross'
              ? totals.earnings
              : definition.basisKind === 'ahv_salary'
                ? guidedBasis.amountCents
                : undefined,
      };
      if (definition.basisKind === 'ahv_salary') automatic.add(definition.id);
    }
    setSelections(next);
    setAutomaticBases(automatic);
  }

  async function nextStep() {
    setLocalError('');
    if (formRef.current && !fieldGuide.check(formRef.current)) return;
    if (step === 0) {
      const fields = formRef.current?.querySelectorAll<
        HTMLInputElement | HTMLSelectElement
      >('[data-payroll-step="0"] input, [data-payroll-step="0"] select');
      for (const field of fields ?? []) if (!field.reportValidity()) return;
      if (!employeeId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return;
      if (
        !item &&
        !automaticProposalApplied.current &&
        !selectedItems.length &&
        proposal.length
      )
        applyProposal();
      automaticProposalApplied.current = true;
      setStep(1);
      return;
    }
    if (
      totals.earnings <= 0 ||
      lines.some(
        (line) =>
          !line.label.trim() ||
          !Number.isSafeInteger(line.amountCents) ||
          line.amountCents < 0,
      )
    ) {
      setLocalError(
        'Indiquez le salaire brut du mois et complétez les montants ajoutés.',
      );
      return;
    }
    const invalid = formRef.current?.querySelector<
      HTMLInputElement | HTMLSelectElement
    >('[data-payroll-step="1"] :invalid');
    if (invalid) {
      let parent = invalid.parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      invalid.reportValidity();
      return;
    }
    if (eligibility.blockers.length) {
      setPreparing(true);
      return;
    }
    if (
      selectedItems.length &&
      !hasCurrentCalculation &&
      !(await calculate())
    ) {
      setShowContributions(true);
      return;
    }
    setStep(2);
  }

  async function calculate() {
    if (calculating || loadingRates || busy) return false;
    setLocalError('');
    setCalculationError('');
    if (usesGuidedBasis && guidedBasis.amountCents === undefined) {
      setCalculationError(
        'Ce salaire contient plusieurs éléments. Renseignez la base de chaque cotisation dans le détail, puis relancez le calcul.',
      );
      return false;
    }
    if (existingBlocked) {
      setCalculationError(
        'Réactivez les définitions historiques indiquées avant de recalculer cette fiche.',
      );
      return false;
    }
    if (!employeeId || !period || totals.earnings <= 0) {
      setCalculationError(
        'Sélectionnez le collaborateur, la période et au moins un gain positif avant le calcul.',
      );
      return false;
    }
    for (const definition of definitions.filter(
      (candidate) => selections[candidate.id],
    )) {
      const selected = selections[definition.id];
      if (
        (definition.basisKind !== 'gross' &&
          selected.basisCents === undefined) ||
        (definition.annualCeilingCents &&
          !['ac', 'aap', 'aanp'].includes(definition.category) &&
          selected.yearToDateBasisCents === undefined)
      ) {
        setCalculationError(
          definition.category === 'lpp' &&
            definition.basisKind === 'coordinated' &&
            selected.basisCents === undefined
            ? 'Confirmez le salaire annuel LPP du collaborateur pour calculer sa base de pension.'
            : `Complétez la base${definition.annualCeilingCents ? ' et le cumul annuel' : ''} pour ${definition.label}.`,
        );
        return false;
      }
    }
    const requestFingerprint = currentCalculationFingerprint;
    const requestRevision = inputRevisionRef.current;
    const request = ++calculationRequest.current;
    setCalculating(true);
    try {
      const result = await desktopApi.calculatePayrollContributions({
        employeeId,
        period,
        paymentDate,
        grossCents: totals.earnings,
        items: selectedItems,
      });
      if (request !== calculationRequest.current) return false;
      if (
        inputRevisionRef.current !== requestRevision ||
        currentFingerprintRef.current !== requestFingerprint
      ) {
        setCalculation(null);
        setCalculatedFingerprint(null);
        setCalculationError(
          'Les données ont changé pendant le calcul. Relancez le calcul des cotisations.',
        );
        return false;
      }
      setCalculation(result);
      setCalculatedFingerprint(requestFingerprint);
      setConfigurationUpdated(false);
      return true;
    } catch (reason) {
      if (request !== calculationRequest.current) return false;
      setCalculation(null);
      setCalculatedFingerprint(null);
      setCalculationError(
        errorMessage(reason, 'Le calcul local des cotisations a échoué.'),
      );
      return false;
    } finally {
      if (request === calculationRequest.current) setCalculating(false);
    }
  }

  async function saveSalaryDraft() {
    if (item || busy || calculating) return;
    setLocalError('');
    if (!employeeId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      setPreparing(false);
      setStep(0);
      setLocalError(
        'Choisissez le collaborateur et le mois avant de conserver un brouillon.',
      );
      return;
    }
    if (
      totals.earnings <= 0 ||
      lines.some(
        (line) =>
          !line.label.trim() ||
          !Number.isSafeInteger(line.amountCents) ||
          line.amountCents < 0,
      )
    ) {
      setPreparing(false);
      setStep(1);
      setLocalError(
        'Indiquez le salaire brut et complétez les montants ajoutés avant de conserver le brouillon.',
      );
      return;
    }
    const notes =
      formRef.current?.querySelector<HTMLTextAreaElement>('[name=notes]')
        ?.value ?? '';
    await act(
      () =>
        desktopApi.savePayslipWithContributions(
          { employeeId, period, paymentDate, notes, status: 'draft' },
          lines,
          undefined,
          period,
          [],
        ),
      'Brouillon enregistré. Retrouvez-le dans les fiches de salaire pour continuer.',
      true,
      (reason) => {
        setPreparing(false);
        setStep(1);
        setLocalError(
          errorMessage(
            reason,
            'Le brouillon n’a pas pu être enregistré. Votre salaire reste dans ce formulaire.',
          ),
        );
      },
    );
  }

  return (
    <Modal
      title={
        setup
          ? 'Préparer la paie'
          : item
            ? 'Modifier la fiche de salaire'
            : 'Nouvelle fiche de salaire'
      }
      description={
        setup
          ? 'Des réglages conservés pour les prochaines fiches.'
          : 'Choisissez la personne, indiquez son salaire et vérifiez le net.'
      }
      className="payroll-dialog"
      onClose={close}
      wide
    >
      {setup && (
        <PayrollSetup
          initial={setup}
          initialSelector={setupSelector}
          employeeId={employeeId}
          period={period}
          workspace={workspace}
          busy={busy}
          act={act}
          onClose={() => setSetup(null)}
          guided={preparing}
          onSaved={() => {
            setLocalError('');
            setConfigurationUpdated(true);
            invalidateCalculation();
            setConfigurationReload((value) => value + 1);
          }}
        />
      )}
      {preparing && !setup && (
        <PayrollPreparation
          employeeName={employee?.name ?? 'votre collaborateur'}
          tasks={payrollPreparationTasks(eligibility.blockers)}
          proposals={missingProposals.map((definition) => definition.label)}
          onApplyProposals={addMissingProposals}
          onSaveDraft={item ? undefined : () => void saveSalaryDraft()}
          busy={busy || calculating || loadingRates || loadingAccounting}
          onFix={fixPayroll}
          onBack={() => setPreparing(false)}
          onContinue={() => {
            setPreparing(false);
            setStep(1);
          }}
        />
      )}
      <div hidden={setup !== null || preparing}>
        <form
          className="payroll-form payroll-wizard"
          ref={formRef}
          noValidate
          onSubmit={submitForm(async (form) => {
            if (busy || calculating) return;
            if (step < 2) {
              await nextStep();
              return;
            }
            setLocalError('');
            if (formRef.current && !fieldGuide.check(formRef.current)) return;
            if (!employeeId || !period) {
              setStep(0);
              return;
            }
            if (
              loadingRates ||
              loadingAccounting ||
              existingBlocked ||
              accountingError
            ) {
              setLocalError(
                'Les cotisations et les comptes de paie doivent être disponibles avant l’enregistrement.',
              );
              return;
            }
            if (
              !lines.length ||
              lines.some((line) => !line.label.trim() || line.amountCents < 0)
            ) {
              setLocalError(
                'Ajoutez des lignes valides avec un libellé et un montant.',
              );
              return;
            }
            if (accountingEnabled) {
              const unclassified = lines.find(
                (line) =>
                  (line.kind === 'deduction' && !line.postingAccountId) ||
                  (line.kind === 'reimbursement' && !line.expenseAccountId) ||
                  (line.kind === 'employer' &&
                    (!line.postingAccountId || !line.expenseAccountId)),
              );
              if (unclassified) {
                setLocalError(
                  `Classez comptablement la ligne « ${unclassified.label || 'sans libellé'} » avant l’enregistrement.`,
                );
                return;
              }
            } else if (
              accountingEnabled === null &&
              lines.some((line) => line.kind !== 'earning')
            ) {
              setLocalError(
                'Les comptes de paie doivent être chargés avant d’enregistrer des retenues, remboursements ou charges.',
              );
              return;
            }
            if (selectedItems.length && !hasCurrentCalculation) {
              await calculate();
              return;
            }
            const wantsValidation =
              workspace.settings?.payroll.fiduciaryValidated &&
              form.get('validated') === 'on';
            if (wantsValidation && eligibility.blockers.length) {
              setLocalError(
                'Il reste des informations à compléter. Utilisez les boutons ci-dessous pour terminer la préparation.',
              );
              return;
            }
            const status: Payslip['status'] = wantsValidation
              ? 'validated'
              : 'incomplete';
            const data = {
              employeeId,
              period,
              status,
              grossCents: totals.earnings,
              deductionsCents: totals.deductions,
              netCents: totals.net,
              employerCostsCents: totals.employer,
              paymentDate,
              notes:
                typeof form.get('notes') === 'string'
                  ? (form.get('notes') as string)
                  : '',
            };
            await act(
              () =>
                desktopApi.savePayslipWithContributions(
                  data,
                  lines,
                  item,
                  period,
                  selectedItems,
                ),
              item
                ? 'La fiche et ses cotisations ont été mises à jour.'
                : 'La fiche de salaire a été enregistrée.',
              true,
              (reason) =>
                setLocalError(
                  errorMessage(reason, 'La fiche n’a pas pu être enregistrée.'),
                ),
            );
          })}
        >
          <ol className="payroll-steps" aria-label="Étapes de création">
            {PAYROLL_STEPS.map((label, index) => (
              <li
                key={label}
                aria-current={step === index ? 'step' : undefined}
              >
                <span>
                  {index < step ? <CheckCircle2 size={16} /> : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
          <div className="payroll-step-intro" ref={headingRef} tabIndex={-1}>
            <h3>
              {
                [
                  'À qui versez-vous ce salaire ?',
                  'Qu’est-ce qui change ce mois-ci ?',
                  'Vérifiez, puis enregistrez.',
                ][step]
              }
            </h3>
            <p>
              {
                [
                  'Choisissez la personne et le mois. Ses informations déjà enregistrées sont reprises.',
                  'Le salaire habituel est prérempli. Ajoutez seulement les compléments nécessaires.',
                  'Le net à payer et les points à compléter sont réunis ici.',
                ][step]
              }
            </p>
          </div>
          {fieldGuide.guide}
          {(loadingRates || loadingAccounting) && (
            <p className="payroll-callout" role="status">
              Chargement des réglages du salaire… Votre saisie reste conservée.
            </p>
          )}
          {localError || calculationError ? (
            <PayrollProblem
              messages={[localError, calculationError]}
              reveal
              onFix={fixPayroll}
              disabled={busy || calculating}
            />
          ) : null}
          {accountingError || ratesError ? (
            <div>
              <PayrollProblem
                messages={[accountingError, ratesError]}
                onFix={fixPayroll}
                disabled={busy || calculating}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={busy || loadingRates || loadingAccounting}
                onClick={() => setConfigurationReload((value) => value + 1)}
              >
                Réessayer le chargement
              </Button>
            </div>
          ) : null}
          <fieldset
            className="payroll-step"
            data-payroll-step="0"
            hidden={step !== 0}
            disabled={step !== 0 || busy}
          >
            <details className="payroll-simple-guide">
              <summary>Ma première fiche : comment faire ?</summary>
              <ol>
                <li>Choisissez la personne et le mois à payer.</li>
                <li>
                  Indiquez le salaire brut : le montant avant les retenues.
                </li>
                <li>Vérifiez le net : le montant à verser au salarié.</li>
              </ol>
              <p>
                Si une information manque, l’app vous propose de la compléter
                sans perdre votre saisie. Enregistrer une fiche ne déclenche
                aucun virement.
              </p>
            </details>
            <div className="form-grid">
              <Field label="Collaborateur" required>
                <select
                  name="employeeId"
                  disabled={Boolean(item)}
                  value={employeeId}
                  onChange={(event) => selectEmployee(event.target.value)}
                  required
                >
                  <option value="">Choisir un collaborateur</option>
                  {workspace.employees
                    .filter(
                      (employee) =>
                        employee.active || employee.id === item?.employeeId,
                    )
                    .map((employee) => (
                      <option value={employee.id} key={employee.id}>
                        {employee.name}
                      </option>
                    ))}
                </select>
              </Field>
              {!item && !employeeId && onAddEmployee && (
                <div className="payroll-first-person">
                  <p>
                    {activeEmployees.length
                      ? 'Cette personne n’est pas encore dans votre liste ?'
                      : 'Commencez par ajouter la personne à qui vous versez ce salaire.'}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onAddEmployee(period, paymentDate)}
                  >
                    <Plus size={16} /> Ajouter le collaborateur et continuer
                  </Button>
                </div>
              )}
              <Field label="Période" required>
                <input
                  name="period"
                  type="month"
                  value={period}
                  onChange={(event) => {
                    setPeriod(event.target.value);
                    setExistingBlocked(false);
                    invalidateCalculation();
                  }}
                  required
                />
              </Field>
              <Field label="Date de paiement">
                <input
                  name="paymentDate"
                  type="date"
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                />
              </Field>
              {!item &&
              employeeId &&
              workspace.employeePayrollTemplates.some(
                (template) => template.employeeId === employeeId,
              ) ? (
                <div className="info-strip">
                  <CheckCircle2 size={17} />
                  <span>
                    Les gains récurrents confirmés lors de l’import ont été
                    préremplis. Vous pouvez les ajuster à l’étape suivante.
                  </span>
                </div>
              ) : null}
            </div>
            {employee ? (
              <div className="payroll-person">
                <strong>{employee.name}</strong>
                <span>
                  {employee.role || 'Collaborateur'} ·{' '}
                  {employee.salaryMode === 'monthly'
                    ? 'Salaire mensuel'
                    : 'Salaire horaire'}
                </span>
                <small>
                  Le contrat et les assurances sont conservés pour les
                  prochaines fiches.
                </small>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onClick={() => {
                    if (!item && !selectedItems.length) applyProposal();
                    setPreparing(true);
                  }}
                >
                  Me guider pour préparer cette fiche
                </Button>
              </div>
            ) : null}
          </fieldset>
          <fieldset
            className="payroll-step"
            data-payroll-step="1"
            hidden={step !== 1}
            disabled={step !== 1 || busy}
          >
            {primaryLine ? (
              <div className="payroll-salary">
                <label>
                  <span>
                    {employee?.salaryMode === 'hourly'
                      ? 'Salaire brut pour les heures de ce mois'
                      : 'Salaire brut du mois'}
                  </span>
                  <span className="money-input">
                    <input
                      aria-label="Salaire brut du mois (CHF)"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={primaryLine.amountCents / 100 || ''}
                      onChange={(event) =>
                        updateLine(primaryLine.id, {
                          amountCents: Math.round(
                            (event.target.valueAsNumber || 0) * 100,
                          ),
                        })
                      }
                      required
                    />
                    <span>CHF</span>
                  </span>
                </label>
                <small>
                  Montant avant retenues, pour le taux d’activité convenu.{' '}
                  {lines.filter((line) => line.kind === 'earning').length > 1
                    ? 'Les compléments ci-dessous s’ajoutent à ce montant.'
                    : ''}
                </small>
              </div>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setLines((current) => [
                    ...current,
                    {
                      id: createId(),
                      kind: 'earning',
                      label: 'Salaire du mois',
                      amountCents: 0,
                    },
                  ]);
                  invalidateCalculation();
                }}
              >
                Indiquer le salaire du mois
              </Button>
            )}
            <details className="payroll-details">
              <summary>
                Ajouter ou modifier un complément de salaire
                {lines.length > 1 ? ` · ${lines.length - 1}` : ''}
              </summary>
              <p>
                Prime, heures supplémentaires, frais ou retenue particulière.
                Les montants inhabituels et leurs bases de cotisation doivent
                être contrôlés.
              </p>
              <section className="pay-lines">
                <header>
                  <div>
                    <strong>Éléments de salaire</strong>
                    <small>
                      Salaire, heures, indemnités, allocations et avantages sont
                      saisis séparément.
                    </small>
                  </div>
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      onClick={() => addLine('earning')}
                    >
                      <Plus size={14} /> Ajouter un élément
                    </Button>
                  </div>
                </header>
                {lines.length ? (
                  <div className="pay-line-list">
                    {lines.map((line, index) => (
                      <div key={line.id}>
                        <select
                          aria-label={`Type de la ligne ${index + 1}`}
                          value={line.kind}
                          onChange={(event) =>
                            changeLineKind(line.id, event.target.value)
                          }
                        >
                          <option value="earning">Salaire / complément</option>
                          <option value="deduction">Retenue manuelle</option>
                          <option value="reimbursement">
                            Remboursement hors brut
                          </option>
                          <option value="employer">Charge employeur</option>
                        </select>
                        <input
                          aria-label={`Libellé de la ligne ${index + 1}`}
                          maxLength={200}
                          value={line.label}
                          onChange={(event) =>
                            updateLine(line.id, { label: event.target.value })
                          }
                          placeholder="Libellé réel"
                          required
                        />
                        <label className="money-input">
                          <input
                            aria-label={`Montant de la ligne ${index + 1} (CHF)`}
                            type="number"
                            min="0"
                            step="0.01"
                            value={
                              line.amountCents ? line.amountCents / 100 : ''
                            }
                            onChange={(event) =>
                              updateLine(line.id, {
                                amountCents: Math.round(
                                  (event.target.valueAsNumber || 0) * 100,
                                ),
                              })
                            }
                            required
                          />
                          <span>CHF</span>
                        </label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Supprimer la ligne ${index + 1}`}
                          onClick={() => {
                            setLines((current) =>
                              current.filter(
                                (candidate) => candidate.id !== line.id,
                              ),
                            );
                            invalidateCalculation();
                          }}
                        >
                          <Archive size={15} />
                        </Button>

                        {accountingEnabled && line.kind !== 'earning' ? (
                          <div className="pay-line-accounting">
                            {line.kind === 'deduction' ||
                            line.kind === 'employer' ? (
                              <label>
                                <span>
                                  {line.kind === 'deduction'
                                    ? 'Compte de contrepartie'
                                    : 'Compte de dette'}
                                </span>
                                <select
                                  value={line.postingAccountId ?? ''}
                                  onChange={(event) =>
                                    updateLine(line.id, {
                                      postingAccountId: event.target.value,
                                    })
                                  }
                                  required
                                >
                                  <option value="">Choisir un compte</option>
                                  {accountingAccounts
                                    .filter((account) =>
                                      line.kind === 'deduction'
                                        ? account.accountType === 'asset' ||
                                          account.accountType === 'liability'
                                        : account.accountType === 'liability',
                                    )
                                    .map((account) => (
                                      <option
                                        key={account.id}
                                        value={account.id}
                                      >
                                        {account.code} · {account.name}
                                      </option>
                                    ))}
                                </select>
                                <small>
                                  {line.kind === 'deduction'
                                    ? 'Actif pour une avance récupérée, passif pour un impôt ou une dette.'
                                    : 'Le montant sera crédité sur cette dette.'}
                                </small>
                              </label>
                            ) : null}
                            {line.kind === 'reimbursement' ||
                            line.kind === 'employer' ? (
                              <label>
                                <span>Compte de charge</span>
                                <select
                                  value={line.expenseAccountId ?? ''}
                                  onChange={(event) =>
                                    updateLine(line.id, {
                                      expenseAccountId: event.target.value,
                                    })
                                  }
                                  required
                                >
                                  <option value="">
                                    Choisir un compte de charge
                                  </option>
                                  {accountingAccounts
                                    .filter(
                                      (account) =>
                                        account.accountType === 'expense',
                                    )
                                    .map((account) => (
                                      <option
                                        key={account.id}
                                        value={account.id}
                                      >
                                        {account.code} · {account.name}
                                      </option>
                                    ))}
                                </select>
                                <small>
                                  {line.kind === 'reimbursement'
                                    ? 'Le remboursement augmente le net sans augmenter le salaire brut.'
                                    : 'La charge employeur sera débitée sur ce compte.'}
                                </small>
                              </label>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rate-empty">
                    Ajoutez les gains et montants confirmés pour cette période.
                  </div>
                )}
              </section>
            </details>
            <details className="payroll-details">
              <summary>Règles et montants de mon canton · 2026</summary>
              <Field
                label="Canton à consulter"
                hint="Ce repère ne modifie pas le canton de paie enregistré ni le canton fiscal du salarié."
              >
                <select
                  value={referenceCanton}
                  onChange={(event) => setReferenceCanton(event.target.value)}
                >
                  <option value="">Choisir un canton</option>
                  {SWISS_FAMILY_ALLOWANCES_2026.map((canton) => (
                    <option key={canton.canton} value={canton.canton}>
                      {canton.name} ({canton.canton})
                    </option>
                  ))}
                </select>
              </Field>
              {period.startsWith('2026-') && cantonReference ? (
                <>
                  <div className="payroll-canton-facts">
                    <div>
                      <small>Allocation pour enfant / mois</small>
                      <strong>{cantonReference.child}</strong>
                    </div>
                    <div>
                      <small>Allocation de formation / mois</small>
                      <strong>{cantonReference.education}</strong>
                    </div>
                  </div>
                  <p>
                    {cantonReference.note} Le montant dépend du droit confirmé
                    par la caisse, du lieu d’activité et de la priorité entre
                    parents.
                  </p>
                  {cantonReference.canton === 'VS' ? (
                    <p>
                      Valais : une cotisation CAF salarié de 0,13 % est prévue
                      en 2026. La définition officielle doit être enregistrée
                      dans les paramètres.
                    </p>
                  ) : (
                    <p>
                      Le financement des allocations est à la charge de
                      l’employeur ; le taux dépend de sa caisse.
                    </p>
                  )}
                </>
              ) : (
                <p>
                  Les références disponibles couvrent 2026. Choisissez le canton
                  concerné pour les consulter.
                </p>
              )}
              <p>
                Les allocations légales ne sont pas soumises à l’AVS. Elles ne
                doivent pas être ajoutées au brut cotisable sans adapter les
                bases. L’impôt à la source nécessite le barème officiel et la
                situation fiscale du salarié.
              </p>
              <div className="payroll-rule-links">
                <a
                  href={SWISS_FAMILY_ALLOWANCES_2026_SOURCE}
                  target="_blank"
                  rel="noreferrer"
                >
                  Allocations officielles 2026
                </a>
                <a href={SOURCE_TAX_TARIFFS} target="_blank" rel="noreferrer">
                  Barèmes fiscaux des 26 cantons
                </a>
              </div>
            </details>
            <section className="payroll-selection" data-payroll-selection>
              <header>
                <div>
                  <strong>Ce qui sera retenu sur le salaire</strong>
                  <small>
                    Les cotisations utilisent les taux et contrats enregistrés.
                  </small>
                </div>
              </header>
              <div className="payroll-proposal">
                <div>
                  <strong>
                    {selectedItems.length
                      ? 'Retenues et charges préparées'
                      : 'Préparer les cotisations'}
                  </strong>
                  <small>
                    AVS, chômage, accidents et caisse de pension selon le profil
                    connu. Vérifiez les assurances particulières dans le détail.
                  </small>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={
                    loadingRates || busy || existingBlocked || !proposal.length
                  }
                  onClick={applyProposal}
                >
                  {selectedItems.length
                    ? 'Reprendre les réglages du profil'
                    : 'Utiliser les réglages du profil'}
                </Button>
              </div>
              {!proposal.length && !loadingRates && (
                <div className="payroll-callout">
                  <strong>Les cotisations ne sont pas encore prêtes</strong>
                  <p>
                    Indiquez les assurances de l’entreprise et les taux de vos
                    contrats. L’assistant vous indique où les trouver.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => fixPayroll('contributions')}
                  >
                    Préparer les cotisations avec l’assistant
                  </Button>
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                size="small"
                disabled={busy || calculating}
                onClick={() => fixPayroll('insurance')}
              >
                Mes caisses et assurances
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="small"
                disabled={busy || calculating}
                onClick={() => fixPayroll('contributions')}
              >
                Ajouter une cotisation depuis mon contrat
              </Button>
              {guidedBasis.requiresClassification ? (
                <div className="payroll-basis-confirmation">
                  <p>
                    Ce salaire contient plusieurs éléments. Dans le détail des
                    cotisations, indiquez le montant soumis à chaque assurance
                    d’après votre contrat ou votre fiduciaire. Les allocations
                    et les remboursements ne se traitent pas tous comme du
                    salaire.
                  </p>
                </div>
              ) : null}
              <details
                className="payroll-details"
                open={showContributions}
                onToggle={(event) =>
                  setShowContributions(event.currentTarget.open)
                }
              >
                <summary>Vérifier les cotisations et leurs bases</summary>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    loadingRates ||
                    calculating ||
                    busy ||
                    existingBlocked ||
                    !selectedItems.length
                  }
                  onClick={() => void calculate()}
                >
                  Calculer les cotisations
                </Button>
                <p>
                  Les cumuls annuels AVS, AC et LAA sont repris automatiquement.
                  Ouvrez ce détail pour modifier une base ou choisir une autre
                  assurance.
                </p>
                {definitions.length ? (
                  <div className="contribution-selection-list">
                    {definitions
                      .filter(
                        (definition) =>
                          definition.category !== 'lpp' ||
                          definition.lppEmployeeId === employeeId ||
                          selections[definition.id],
                      )
                      .map((definition) => {
                        const selected = selections[definition.id];
                        return (
                          <article
                            key={definition.id}
                            className={selected ? 'is-selected' : ''}
                          >
                            <label aria-label={definition.label}>
                              <input
                                type="checkbox"
                                checked={Boolean(selected)}
                                onChange={(event) =>
                                  toggleDefinition(
                                    definition,
                                    event.target.checked,
                                  )
                                }
                              />
                              <span>
                                <strong>
                                  {definition.code} · {definition.label}
                                </strong>
                                <small>
                                  Part{' '}
                                  {definition.side === 'employee'
                                    ? 'employé'
                                    : 'employeur'}{' '}
                                  ·{' '}
                                  {definition.calculationKind === 'rate'
                                    ? `${((definition.rateBp ?? 0) / 100).toLocaleString('fr-CH')} %`
                                    : formatMoney(
                                        definition.fixedAmountCents,
                                      )}{' '}
                                  · {PAYROLL_BASIS_LABELS[definition.basisKind]}
                                </small>
                                <small>{definition.source}</small>
                              </span>
                            </label>
                            {selected ? (
                              <div className="selection-bases">
                                <Field
                                  label={
                                    definition.category === 'lpp' &&
                                    definition.basisKind === 'coordinated'
                                      ? 'Salaire coordonné annuel 2026 (CHF)'
                                      : `Base de calcul (CHF) · ${definition.label}`
                                  }
                                  hint={
                                    definition.category === 'lpp' &&
                                    definition.basisKind === 'coordinated'
                                      ? 'Calculé automatiquement depuis le salaire annuel LPP et les bornes légales 2026.'
                                      : 'Part du salaire soumise à cette assurance, avant retenue. Montant en CHF, deux décimales maximum. Ne mettez pas zéro si le montant est inconnu.'
                                  }
                                  required
                                >
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={
                                      selected.basisCents === undefined
                                        ? ''
                                        : selected.basisCents / 100
                                    }
                                    onChange={(event) =>
                                      patchSelection(definition.id, {
                                        basisCents:
                                          event.target.value === ''
                                            ? undefined
                                            : Math.round(
                                                (event.target.valueAsNumber ||
                                                  0) * 100,
                                              ),
                                      })
                                    }
                                    readOnly={
                                      definition.basisKind === 'gross' ||
                                      (definition.category === 'lpp' &&
                                        definition.basisKind === 'coordinated')
                                    }
                                    required
                                  />
                                </Field>
                                {definition.annualCeilingCents &&
                                !['ac', 'aap', 'aanp'].includes(
                                  definition.category,
                                ) ? (
                                  <Field
                                    label="Base cumulée avant ce mois (CHF)"
                                    required
                                    hint={`Plafond annuel ${formatMoney(definition.annualCeilingCents)}`}
                                  >
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      value={
                                        selected.yearToDateBasisCents ===
                                        undefined
                                          ? ''
                                          : selected.yearToDateBasisCents / 100
                                      }
                                      onChange={(event) =>
                                        patchSelection(definition.id, {
                                          yearToDateBasisCents:
                                            event.target.value === ''
                                              ? undefined
                                              : Math.round(
                                                  (event.target.valueAsNumber ||
                                                    0) * 100,
                                                ),
                                        })
                                      }
                                      required
                                    />
                                  </Field>
                                ) : ['ac', 'aap', 'aanp'].includes(
                                    definition.category,
                                  ) ? (
                                  <div className="info-strip">
                                    <ShieldCheck size={16} />
                                    <span>
                                      Le cumul{' '}
                                      {definition.category === 'ac'
                                        ? 'AC'
                                        : 'LAA'}{' '}
                                      reprend la base d’ouverture confirmée et
                                      les fiches antérieures de la même année.
                                    </span>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                  </div>
                ) : (
                  <div className="warning-card">
                    <ShieldCheck size={18} />
                    <div>
                      <strong>Aucune définition active</strong>
                      <p>
                        Configurez les cotisations dans Paramètres avant de
                        calculer une fiche.
                      </p>
                    </div>
                  </div>
                )}
              </details>
            </section>
          </fieldset>
          <fieldset
            className="payroll-step"
            data-payroll-step="2"
            hidden={step !== 2}
            disabled={step !== 2 || busy}
          >
            {(configurationUpdated ||
              (selectedItems.length > 0 && !hasCurrentCalculation)) && (
              <section className="payroll-next-action" role="status">
                <strong>
                  {configurationUpdated
                    ? 'Réglage enregistré. Vérifions son effet sur le salaire.'
                    : 'Votre salaire a changé. Actualisons le net.'}
                </strong>
                <p>
                  Le salaire saisi et vos notes sont conservés. Cliquez sur «
                  Recalculer le salaire » en bas, puis contrôlez le nouveau net
                  avant d’enregistrer.
                </p>
              </section>
            )}
            {missingProposals.length > 0 && (
              <section className="payroll-next-action">
                <strong>
                  {missingProposals.length} cotisation
                  {missingProposals.length > 1 ? 's' : ''} du profil à ajouter à
                  cette fiche
                </strong>
                <p>
                  Ces cotisations sont enregistrées et proposées pour cette
                  personne et ce mois. Vérifiez la liste avant de les appliquer.
                  Vos bases déjà saisies restent conservées.
                </p>
                <details>
                  <summary>Voir les cotisations proposées</summary>
                  <ul>
                    {missingProposals.map((definition) => (
                      <li key={definition.id}>{definition.label}</li>
                    ))}
                  </ul>
                </details>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || calculating || loadingRates}
                  onClick={addMissingProposals}
                >
                  Appliquer les nouvelles cotisations
                </Button>
              </section>
            )}
            <div className="payroll-net" aria-live="polite">
              <span>Net à payer à {employee?.name}</span>
              <strong>
                {selectedItems.length && hasCurrentCalculation
                  ? formatMoney(
                      totals.net - (calculation?.employeeDeductionsCents ?? 0),
                    )
                  : 'Cotisations à compléter'}
              </strong>
              <div className="payroll-net-breakdown">
                <span>Brut {formatMoney(totals.earnings)}</span>
                <span>
                  Retenues{' '}
                  {hasCurrentCalculation
                    ? formatMoney(
                        totals.deductions +
                          (calculation?.employeeDeductionsCents ?? 0),
                      )
                    : 'à calculer'}
                </span>
                {totals.reimbursements > 0 ? (
                  <span>Frais {formatMoney(totals.reimbursements)}</span>
                ) : null}
              </div>
            </div>
            {eligibility.blockers.length || !selectedItems.length ? (
              <div className="payroll-issues">
                <strong>Terminons la préparation</strong>
                <p>
                  Commençons par le premier point. Le bouton ouvre le bon
                  réglage, puis vous revenez ici sans perdre votre salaire ni
                  vos notes.
                </p>
                <PayrollProblem
                  messages={
                    !selectedItems.length
                      ? [
                          'Choisissez les cotisations applicables à l’étape précédente.',
                          ...eligibility.blockers,
                        ]
                      : eligibility.blockers
                  }
                  onFix={fixPayroll}
                  disabled={busy || calculating}
                />
              </div>
            ) : null}
            {eligibility.warnings.length ? (
              <details className="payroll-details">
                <summary>
                  Points à vérifier · {eligibility.warnings.length}
                </summary>
                {eligibility.warnings.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </details>
            ) : null}
            <details className="payroll-details">
              <summary>Contrôles détaillés</summary>
              <section className="payroll-eligibility">
                <header>
                  <ShieldCheck size={18} />
                  <div>
                    <strong>Contrôles d’assujettissement 2026</strong>
                    <small>
                      Ces contrôles signalent les paramètres manquants; votre
                      caisse, CCT ou fiduciaire reste la référence finale.
                    </small>
                  </div>
                </header>
                <div className="payroll-eligibility__facts">
                  {eligibility.facts.map((fact) => (
                    <div className={`is-${fact.tone}`} key={fact.label}>
                      <span>{fact.label}</span>
                      <strong>{fact.value}</strong>
                    </div>
                  ))}
                </div>
                {eligibility.blockers.length ? (
                  <div className="payroll-eligibility__issues is-blocking">
                    <strong>Validation bloquée</strong>
                    {eligibility.blockers.map((message) => (
                      <p key={message}>{message}</p>
                    ))}
                  </div>
                ) : null}
                {eligibility.warnings.length ? (
                  <div className="payroll-eligibility__issues">
                    <strong>À confirmer</strong>
                    {eligibility.warnings.map((message) => (
                      <p key={message}>{message}</p>
                    ))}
                  </div>
                ) : null}
              </section>
            </details>
            <details className="payroll-details">
              <summary>Comprendre le calcul du salaire</summary>
              {hasCurrentCalculation && calculation ? (
                <section className="payroll-calculation">
                  <header>
                    <CheckCircle2 size={18} />
                    <div>
                      <strong>Calcul contrôlable</strong>
                      <small>
                        Période {calculation.period} · brut{' '}
                        {formatMoney(calculation.grossCents)}
                      </small>
                    </div>
                  </header>
                  {calculation.smallSalaryAssessment ? (
                    <div className="payroll-small-salary-result">
                      <div className="payroll-small-salary-result__heading">
                        <ShieldCheck size={17} />
                        <div>
                          <strong>Décision annuelle calculée localement</strong>
                          <small>
                            {smallSalarySectorLabel(
                              calculation.smallSalaryAssessment.sector,
                            )}{' '}
                            · {calculation.smallSalaryAssessment.assessmentYear}{' '}
                            ·{' '}
                            {smallSalaryReasonLabel(
                              calculation.smallSalaryAssessment.reasonCode,
                            )}
                          </small>
                        </div>
                      </div>
                      <div className="payroll-small-salary-result__facts">
                        <div>
                          <span>Cumul brut annuel</span>
                          <strong>
                            {formatMoney(
                              calculation.smallSalaryAssessment
                                .cumulativeGrossCents,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Avant cette fiche</span>
                          <strong>
                            {formatMoney(
                              calculation.smallSalaryAssessment
                                .openingGrossCents +
                                calculation.smallSalaryAssessment
                                  .priorGrossCents,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Base déjà cotisée</span>
                          <strong>
                            {formatMoney(
                              calculation.smallSalaryAssessment
                                .openingContributedBasisCents +
                                calculation.smallSalaryAssessment
                                  .priorContributedBasisCents,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Seuil appliqué</span>
                          <strong>
                            {formatMoney(
                              calculation.smallSalaryAssessment.thresholdCents,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Cotisations dues</span>
                          <strong>
                            {calculation.smallSalaryAssessment.contributionsDue
                              ? 'Oui'
                              : 'Non'}
                          </strong>
                        </div>
                        <div>
                          <span>Date de décision</span>
                          <strong>
                            {calculation.smallSalaryAssessment.decisionDate}
                          </strong>
                        </div>
                        <div>
                          <span>Assiette totale cotisée</span>
                          <strong>
                            {formatMoney(
                              calculation.smallSalaryAssessment
                                .statutoryContributionBasisCents,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Dont rattrapage historique</span>
                          <strong>
                            {calculation.smallSalaryAssessment
                              .statutoryCatchupBasisCents > 0
                              ? formatMoney(
                                  calculation.smallSalaryAssessment
                                    .statutoryCatchupBasisCents,
                                )
                              : 'Aucun'}
                          </strong>
                        </div>
                      </div>
                      {calculation.smallSalaryAssessment
                        .statutoryCatchupBasisCents > 0 ? (
                        <div className="payroll-small-salary-result__catchup">
                          Le seuil est franchi: cette base de rattrapage couvre
                          le brut antérieur encore non cotisé. Elle vient du
                          cumul vérifié par le moteur, sans saisie manuelle sur
                          la fiche.
                        </div>
                      ) : null}
                      <small className="payroll-small-salary-result__evidence">
                        Preuve:{' '}
                        {calculation.smallSalaryAssessment.evidenceReference}
                      </small>
                    </div>
                  ) : null}
                  <div className="payroll-calculation-lines">
                    {calculation.items.map((result) => (
                      <div key={`${result.id}-${result.side}`}>
                        <span>
                          {result.label}
                          <small>
                            Base {formatMoney(result.basisCents)} ·{' '}
                            {result.rateBp !== null
                              ? `${(result.rateBp / 100).toLocaleString('fr-CH')} %`
                              : 'montant fixe'}
                            {result.category === 'ac' &&
                            result.yearToDateBasisCents !== null
                              ? ` · cumul antérieur ${formatMoney(result.yearToDateBasisCents)}`
                              : ''}
                          </small>
                        </span>
                        <strong>{formatMoney(result.amountCents)}</strong>
                      </div>
                    ))}
                  </div>
                  <footer>
                    <span>
                      Retenues employé{' '}
                      <strong>
                        {formatMoney(calculation.employeeDeductionsCents)}
                      </strong>
                    </span>
                    <span>
                      Charges employeur{' '}
                      <strong>
                        {formatMoney(calculation.employerCostsCents)}
                      </strong>
                    </span>
                  </footer>
                </section>
              ) : null}
            </details>
            <div className="document-bottom">
              <div>
                <Field label="Notes">
                  <textarea name="notes" rows={3} defaultValue={item?.notes} />
                </Field>
              </div>
              <details className="payroll-details">
                <summary>Détail des montants</summary>
                <div className="document-totals">
                  <div>
                    <span>Brut saisi</span>
                    <strong>{formatMoney(totals.earnings)}</strong>
                  </div>
                  <div>
                    <span>Remboursements hors brut</span>
                    <strong>{formatMoney(totals.reimbursements)}</strong>
                  </div>
                  <div>
                    <span>Retenues manuelles</span>
                    <strong>{formatMoney(totals.deductions)}</strong>
                  </div>
                  <div>
                    <span>Net avant cotisations calculées</span>
                    <strong>{formatMoney(totals.net)}</strong>
                  </div>
                  <div>
                    <span>Cotisations employé</span>
                    <strong>
                      {selectedItems.length && !hasCurrentCalculation
                        ? 'À recalculer'
                        : formatMoney(
                            calculation?.employeeDeductionsCents ?? 0,
                          )}
                    </strong>
                  </div>
                  <div className="total-main" aria-live="polite">
                    <span>
                      {eligibility.blockers.length
                        ? 'Net calculé · à contrôler'
                        : 'Net à payer'}
                    </span>
                    <strong>
                      {selectedItems.length && !hasCurrentCalculation
                        ? 'À recalculer'
                        : formatMoney(
                            totals.net -
                              (calculation?.employeeDeductionsCents ?? 0),
                          )}
                    </strong>
                  </div>
                </div>
              </details>
            </div>
            {workspace.settings?.payroll.fiduciaryValidated ? (
              <label className="check-card" aria-label="Valider cette fiche">
                <input
                  name="validated"
                  type="checkbox"
                  defaultChecked={item?.status === 'validated'}
                  disabled={eligibility.blockers.length > 0}
                />
                <span>
                  <strong>Valider cette fiche</strong>
                  <small>
                    {eligibility.blockers.length
                      ? 'Corrigez les contrôles d’assujettissement bloquants ci-dessus.'
                      : 'Confirmez que les bases, taux et résultats ont été contrôlés.'}
                  </small>
                </span>
              </label>
            ) : (
              <div className="warning-card">
                <ShieldCheck size={18} />
                <div>
                  <strong>La fiche restera à contrôler</strong>
                  <p>
                    La configuration de paie n’est pas marquée comme validée par
                    une fiduciaire.
                  </p>
                </div>
              </div>
            )}
          </fieldset>
          <div className="payroll-actions">
            {step > 0 ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy || calculating}
                onClick={() => {
                  setLocalError('');
                  setStep(step - 1);
                }}
              >
                <ArrowLeft size={16} /> Retour
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={close}
              >
                Annuler
              </Button>
            )}
            {step < 2 ? (
              <Button
                type="submit"
                disabled={
                  busy ||
                  calculating ||
                  loadingRates ||
                  loadingAccounting ||
                  existingBlocked ||
                  Boolean(accountingError)
                }
              >
                {calculating
                  ? 'Calcul en cours…'
                  : step === 0
                    ? 'Continuer'
                    : 'Vérifier le salaire'}
                <ArrowRight size={16} />
              </Button>
            ) : (
              <FormActions
                onCancel={close}
                busy={busy}
                submitLabel={
                  calculating
                    ? 'Calcul en cours…'
                    : selectedItems.length > 0 && !hasCurrentCalculation
                      ? 'Recalculer le salaire'
                      : 'Enregistrer la fiche'
                }
                disabled={
                  calculating ||
                  loadingRates ||
                  loadingAccounting ||
                  existingBlocked ||
                  Boolean(accountingError)
                }
              />
            )}
          </div>
        </form>
      </div>
    </Modal>
  );
}
