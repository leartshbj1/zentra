import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CheckCircle2, Plus, ShieldCheck } from 'lucide-react';
import { desktopApi } from './bridge';
import {
  isPayrollCalculationCurrent,
  payrollCalculationFingerprint,
} from './payrollCalculationFingerprint';
import { assessSwissPayrollEligibility } from './payrollEligibility';
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
import {
  Button,
  ErrorPanel,
  Field,
  FormActions,
  Modal,
  submitForm,
} from './ui';

type ActionRunner = (
  action: () => Promise<Workspace>,
  message: string,
  close?: boolean,
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
}: {
  item?: Payslip;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const [lines, setLines] = useState<PayslipLine[]>(
    item?.lines.map((line) => ({ ...line })) ?? [],
  );
  const [definitions, setDefinitions] = useState<
    PayrollContributionDefinition[]
  >([]);
  const [accountingAccounts, setAccountingAccounts] = useState<Account[]>([]);
  const [accountingEnabled, setAccountingEnabled] = useState<boolean | null>(
    null,
  );
  const [loadingAccounting, setLoadingAccounting] = useState(true);
  const [selections, setSelections] = useState<Record<string, SelectionDraft>>(
    {},
  );
  const [calculation, setCalculation] = useState<PayrollCalculation | null>(
    null,
  );
  const [calculatedFingerprint, setCalculatedFingerprint] = useState<
    string | null
  >(null);
  const [calculationError, setCalculationError] = useState('');
  const [period, setPeriod] = useState(item?.period ?? '');
  const [employeeId, setEmployeeId] = useState(item?.employeeId ?? '');
  const [paymentDate, setPaymentDate] = useState(item?.paymentDate ?? '');
  const [loadingRates, setLoadingRates] = useState(true);
  const [existingBlocked, setExistingBlocked] = useState(false);
  const [localError, setLocalError] = useState('');
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

  useEffect(() => {
    let active = true;
    setLoadingAccounting(true);
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
        setLocalError(
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
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingRates(true);
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
          item &&
            period === item.period &&
            paymentDate === item.paymentDate,
        );
        const periodSnapshots = restoresOriginalContext ? snapshots : [];
        const missing = periodSnapshots.filter(
          (snapshot) =>
            !available.some(
              (definition) => definition.id === snapshot.definitionId,
            ),
        );
        setDefinitions(available);
        if (item && hydratedPayslipIdRef.current !== item.id) {
          setLines(
            item.lines
              .filter((line) => !linkedItems.has(line.id))
              .map((line) => ({ ...line })),
          );
          hydratedPayslipIdRef.current = item.id;
        }
        setSelections(
          Object.fromEntries(
            periodSnapshots.map((snapshot) => [
              snapshot.definitionId,
              {
                basisCents: snapshot.basisCents,
                yearToDateBasisCents:
                  snapshot.yearToDateBasisCents ?? undefined,
              },
            ]),
          ),
        );
        setExistingBlocked(missing.length > 0);
        invalidateCalculation();
        if (missing.length)
          setLocalError(
            `Réactivez les définitions suivantes avant de modifier cette fiche : ${missing.map((snapshot) => snapshot.label).join(', ')}.`,
          );
      })
      .catch((reason) => {
        if (!active) return;
        setExistingBlocked(Boolean(item));
        setLocalError(
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
  }, [item, paymentDate, period]);

  const selectedItems = useMemo<PayrollContributionSelection[]>(
    () =>
      Object.entries(selections).map(([definitionId, values]) => ({
        definitionId,
        ...values,
      })),
    [selections],
  );
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
        grossCents: totals.earnings,
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
      workspace.employees,
      workspace.settings,
    ],
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
    setCalculation(null);
    setCalculatedFingerprint(null);
    setCalculationError('');
  }

  function addLine(kind: PayslipLine['kind']) {
    setLines((current) => [
      ...current,
      { id: createId(), label: '', kind, amountCents: 0 },
    ]);
    invalidateCalculation();
  }
  function updateLine(id: string, patch: Partial<PayslipLine>) {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
    invalidateCalculation();
  }

  function changeLineKind(id: string, kind: PayslipLine['kind']) {
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
        definition.category === 'lpp' &&
        definition.basisKind === 'coordinated'
        ? eligibility.coordinatedAnnualSalaryCents ?? undefined
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
    if (id !== employeeId) {
      setSelections({});
      setExistingBlocked(false);
      invalidateCalculation();
    }
    setEmployeeId(id);
    if (item || lines.length || !id) return;
    const template = workspace.employeePayrollTemplates.find(
      (candidate) => candidate.employeeId === id,
    );
    if (!template) return;
    const recurring = template.recurringEarnings.length
      ? template.recurringEarnings
      : template.baseSalaryCents > 0
        ? [
            {
              label:
                template.salaryMode === 'monthly'
                  ? 'Salaire mensuel'
                  : 'Salaire de base',
              kind: 'earning' as const,
              amountCents: template.baseSalaryCents,
            },
          ]
        : [];
    setLines(
      recurring.map((line) => ({
        id: createId(),
        label: line.label,
        kind: 'earning',
        amountCents: line.amountCents,
      })),
    );
    invalidateCalculation();
  }

  async function calculate() {
    setLocalError('');
    setCalculationError('');
    if (existingBlocked) {
      setCalculationError(
        'Réactivez les définitions historiques indiquées avant de recalculer cette fiche.',
      );
      return;
    }
    if (!employeeId || !period || totals.earnings <= 0) {
      setCalculationError(
        'Sélectionnez le collaborateur, la période et au moins un gain positif avant le calcul.',
      );
      return;
    }
    for (const definition of definitions.filter(
      (candidate) => selections[candidate.id],
    )) {
      const selected = selections[definition.id];
      if (
        (definition.basisKind !== 'gross' &&
          selected.basisCents === undefined) ||
        (definition.annualCeilingCents &&
          definition.category !== 'ac' &&
          selected.yearToDateBasisCents === undefined)
      ) {
        setCalculationError(
          `Complétez la base${definition.annualCeilingCents ? ' et le cumul annuel' : ''} pour ${definition.label}.`,
        );
        return;
      }
    }
    const requestFingerprint = currentCalculationFingerprint;
    const requestRevision = inputRevisionRef.current;
    try {
      const result = await desktopApi.calculatePayrollContributions({
        employeeId,
        period,
        paymentDate,
        grossCents: totals.earnings,
        items: selectedItems,
      });
      if (
        inputRevisionRef.current !== requestRevision ||
        currentFingerprintRef.current !== requestFingerprint
      ) {
        setCalculation(null);
        setCalculatedFingerprint(null);
        setCalculationError(
          'Les données ont changé pendant le calcul. Relancez le calcul des cotisations.',
        );
        return;
      }
      setCalculation(result);
      setCalculatedFingerprint(requestFingerprint);
    } catch (reason) {
      setCalculation(null);
      setCalculatedFingerprint(null);
      setCalculationError(
        errorMessage(reason, 'Le calcul local des cotisations a échoué.'),
      );
    }
  }

  return (
    <Modal
      title={item ? 'Modifier la fiche détaillée' : 'Nouvelle fiche de salaire'}
      description="Gains, bases, taux, plafonds et parts sont visibles. Aucune retenue n’est estimée."
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async (form) => {
          setLocalError('');
          if (loadingRates || existingBlocked) {
            setLocalError(
              'Le détail des cotisations doit être disponible avant l’enregistrement.',
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
            setLocalError(
              'Les données de paie ont changé. Recalculez et contrôlez les cotisations avant d’enregistrer.',
            );
            return;
          }
          const wantsValidation =
            workspace.settings?.payroll.fiduciaryValidated &&
            form.get('validated') === 'on';
          if (wantsValidation && eligibility.blockers.length) {
            setLocalError(
              `Validation bloquée : ${eligibility.blockers.join(' ')}`,
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
            notes: String(form.get('notes')),
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
              : 'La fiche et ses cotisations explicites ont été enregistrées.',
          );
        })}
      >
        <div className="form-grid">
          <Field label="Collaborateur" required>
            <select
              name="employeeId"
              value={employeeId}
              onChange={(event) => selectEmployee(event.target.value)}
              required
            >
              <option value="">Choisir un collaborateur</option>
              {workspace.employees.map((employee) => (
                <option value={employee.id} key={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Période" required>
            <input
              name="period"
              type="month"
              value={period}
              onChange={(event) => {
                setPeriod(event.target.value);
                setSelections({});
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
                préremplis. Les cotisations restent à sélectionner et recalculer
                pour cette période.
              </span>
            </div>
          ) : null}
        </div>
        {localError ? <ErrorPanel message={localError} /> : null}
        {calculationError ? <ErrorPanel message={calculationError} /> : null}
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
                <Plus size={14} /> Gain
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => addLine('deduction')}
              >
                <Plus size={14} /> Retenue hors moteur
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => addLine('reimbursement')}
              >
                <Plus size={14} /> Remboursement hors brut
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => addLine('employer')}
              >
                <Plus size={14} /> Charge hors moteur
              </Button>
            </div>
          </header>
          {lines.length ? (
            <div className="pay-line-list">
              {lines.map((line) => (
                <div key={line.id}>
                  <select
                    value={line.kind}
                    onChange={(event) =>
                      changeLineKind(
                        line.id,
                        event.target.value as PayslipLine['kind'],
                      )
                    }
                  >
                    <option value="earning">Gain</option>
                    <option value="deduction">Retenue hors moteur</option>
                    <option value="reimbursement">
                      Remboursement hors brut
                    </option>
                    <option value="employer">
                      Charge employeur hors moteur
                    </option>
                  </select>
                  <input
                    value={line.label}
                    onChange={(event) =>
                      updateLine(line.id, { label: event.target.value })
                    }
                    placeholder="Libellé réel"
                    required
                  />
                  <label className="money-input">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.amountCents ? line.amountCents / 100 : ''}
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
                    onClick={() => {
                      setLines((current) =>
                        current.filter((candidate) => candidate.id !== line.id),
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
                                <option key={account.id} value={account.id}>
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
                            <option value="">Choisir un compte de charge</option>
                            {accountingAccounts
                              .filter(
                                (account) =>
                                  account.accountType === 'expense',
                              )
                              .map((account) => (
                                <option key={account.id} value={account.id}>
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
        <section className="payroll-eligibility">
          <header>
            <ShieldCheck size={18} />
            <div>
              <strong>Contrôles d’assujettissement 2026</strong>
              <small>
                Ces contrôles signalent les paramètres manquants; votre caisse,
                CCT ou fiduciaire reste la référence finale.
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
        <section className="payroll-selection">
          <header>
            <div>
              <strong>Cotisations à appliquer</strong>
              <small>
                Choisissez les définitions réellement applicables à ce
                collaborateur.
              </small>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={
                loadingRates || existingBlocked || !selectedItems.length
              }
              onClick={() => void calculate()}
            >
              Calculer les cotisations
            </Button>
          </header>
          {definitions.length ? (
            <div className="contribution-selection-list">
              {definitions.map((definition) => {
                const selected = selections[definition.id];
                return (
                  <article
                    key={definition.id}
                    className={selected ? 'is-selected' : ''}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(selected)}
                        onChange={(event) =>
                          toggleDefinition(definition, event.target.checked)
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
                            : formatMoney(definition.fixedAmountCents)}{' '}
                          · base {definition.basisKind}
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
                              : 'Base de calcul (CHF)'
                          }
                          hint={
                            definition.category === 'lpp' &&
                            definition.basisKind === 'coordinated'
                              ? 'Calculé automatiquement depuis le salaire annuel LPP et les bornes légales 2026.'
                              : undefined
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
                                basisCents: Math.round(
                                  (event.target.valueAsNumber || 0) * 100,
                                ),
                              })
                            }
                            readOnly={
                              definition.category === 'lpp' &&
                              definition.basisKind === 'coordinated'
                            }
                            required
                          />
                        </Field>
                        {definition.annualCeilingCents && definition.category !== 'ac' ? (
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
                                selected.yearToDateBasisCents === undefined
                                  ? ''
                                  : selected.yearToDateBasisCents / 100
                              }
                              onChange={(event) =>
                                patchSelection(definition.id, {
                                  yearToDateBasisCents: Math.round(
                                    (event.target.valueAsNumber || 0) * 100,
                                  ),
                                })
                              }
                              required
                            />
                          </Field>
                        ) : definition.category === 'ac' ? (
                          <div className="info-strip">
                            <ShieldCheck size={16} />
                            <span>
                              Le cumul AC est calculé côté Rust : base d’ouverture confirmée du collaborateur + bases AC des fiches Zentra antérieures de la même année.
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
                  Configurez les cotisations dans Paramètres avant de calculer
                  une fiche.
                </p>
              </div>
            </div>
          )}
        </section>
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
                      {result.category === 'ac' && result.yearToDateBasisCents !== null
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
                <strong>{formatMoney(calculation.employerCostsCents)}</strong>
              </span>
            </footer>
          </section>
        ) : null}
        <div className="document-bottom">
          <div>
            <Field label="Notes">
              <textarea name="notes" rows={3} defaultValue={item?.notes} />
            </Field>
          </div>
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
          </div>
        </div>
        {workspace.settings?.payroll.fiduciaryValidated ? (
          <label className="check-card">
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
                La configuration de paie n’est pas marquée comme validée par une
                fiduciaire.
              </p>
            </div>
          </div>
        )}
        <FormActions
          onCancel={close}
          busy={
            busy || loadingRates || loadingAccounting || existingBlocked
          }
        />
      </form>
    </Modal>
  );
}
