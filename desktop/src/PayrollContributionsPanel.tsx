import { t, useAppLanguage, getAppLocale } from './language';
import { PayrollSelect } from './PayrollSelect';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PayrollProblem } from './PayrollProblem';
import { usePayrollFieldGuide } from './PayrollFieldGuide';
import type { PayrollHelpTarget } from './payrollHelp';
import { revealPayrollField } from './payrollNavigation';
import {
  Archive,
  CheckCircle2,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { desktopApi } from './bridge';
import type {
  Account,
  Employee,
  LppComponent,
  PayrollContributionDefinition,
} from './types';
import { centsFromInput, errorMessage } from './utils';
import {
  Button,
  EmptyState,
  Field,
  SectionHeading,
  StatusBadge,
  submitForm,
} from './ui';

const categoryLabels: Record<
  PayrollContributionDefinition['category'],
  string
> = {
  avs_ai_apg: 'AVS / AI / APG',
  ac: 'Assurance-chômage',
  lpp: 'LPP',
  aanp: 'Accidents non professionnels',
  aap: 'Accidents professionnels',
  ijm: 'Indemnités journalières maladie',
  family_allowance: 'Allocations familiales',
  source_tax: 'Impôt à la source',
  other: 'Autre',
};

const lppComponentLabels: Record<LppComponent, string> = {
  risk: 'Risque décès / invalidité',
  savings: 'Épargne vieillesse',
  combined: 'Risque et épargne combinés',
};

export function PayrollContributionsPanel({
  onChanged,
  onBusyChange,
  onFix,
}: { onChanged?: () => void; onBusyChange?: (busy: boolean) => void; onFix?: (target: PayrollHelpTarget) => void } = {}) {
  useAppLanguage();
  const container = useRef<HTMLElement>(null);
  const [definitions, setDefinitions] = useState<
    PayrollContributionDefinition[]
  >([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [lppRegulationReference, setLppRegulationReference] = useState('');
  const [draft, setDraft] =
    useState<Partial<PayrollContributionDefinition> | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [nextDefinitions, nextAccounts, workspace] = await Promise.all([
      desktopApi.listPayrollContributionDefinitions(),
      desktopApi.listAccounts(),
      desktopApi.loadWorkspace(),
    ]);
    setDefinitions(nextDefinitions);
    setAccounts(nextAccounts);
    setEmployees(workspace.employees);
    const plan = workspace.settings?.payroll.lppPlanEvidence;
    setLppRegulationReference(plan?.regulationReference ?? '');
  }, []);

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (success) {
        setNotice(success);
        onChanged?.();
      }
    } catch (reason) {
      setError(
        errorMessage(reason, 'La cotisation n’a pas pu être enregistrée.'),
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(load)
      .catch((reason) => {
        if (active)
          setError(
            errorMessage(
              reason,
              'Les cotisations sont momentanément indisponibles.',
            ),
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  return (
    <section className="panel settings-card settings-card--wide payroll-definitions" ref={container}>
      <SectionHeading
        eyebrow={t("Moteur de paie")}
        title={t("Définitions de cotisations")}
        description={t("Chaque base, montant, plafond, part, source et période d’effet est conservé explicitement.")}
        action={
          <div className="heading-actions">
            <Button variant="ghost" size="small" onClick={() => void run(load)}>
              <RefreshCw size={14} />{t(" Actualiser")}</Button>
            <Button size="small" onClick={() => setDraft({})}>
              <Plus size={14} />{t(" Nouvelle cotisation")}</Button>
          </div>
        }
      />
      {error ? <PayrollProblem messages={[error]} reveal disabled={busy} onFix={(target) => {
        if (onFix && ['person', 'pension-person', 'pension-plan', 'insurance', 'history', 'situation', 'accounts'].includes(target)) onFix(target);
        else if (draft) revealPayrollField(container.current, 'form');
        else void run(load);
      }} /> : null}
      {notice ? (
        <div className="notice notice--success">
          <span>
            <CheckCircle2 size={17} />
            {t(notice)}
          </span>
          <button aria-label={t("Masquer le message")} onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      ) : null}
      {draft ? (
        <ContributionForm
          key={draft.id ?? 'new'}
          draft={draft}
          accounts={accounts}
          employees={employees}
          lppRegulationReference={lppRegulationReference}
          busy={busy}
          onCancel={() => setDraft(null)}
          onSubmit={(input) =>
            void run(async () => {
              await desktopApi.upsertPayrollContributionDefinition(input);
              setDraft(null);
              await load();
            }, 'La définition de cotisation a été enregistrée.')
          }
        />
      ) : null}
      {definitions.length ? (
        <div className="contribution-list">
          {definitions.map((definition) => {
            const employee = employees.find(
              (item) => item.id === definition.lppEmployeeId,
            );
            return (
              <article key={definition.id}>
                <header>
                  <div>
                    <strong>
                      {definition.code} · {definition.label}
                    </strong>
                    <small>
                      {t(categoryLabels[definition.category])} ·{' '}
                      {definition.side === 'employee' ? t("employé") : t("employeur")}
                    </small>
                  </div>
                  <StatusBadge
                    status={definition.active ? 'validated' : 'incomplete'}
                  />
                </header>
                <div className="contribution-facts">
                  <span>{t("Calcul")}{' '}
                    <strong>
                      {definition.calculationKind === 'rate'
                        ? `${((definition.rateBp ?? 0) / 100).toLocaleString(getAppLocale())} %`
                        : t("{v0} CHF", { v0: ((definition.fixedAmountCents ?? 0) / 100).toLocaleString(getAppLocale()) })}
                    </strong>
                  </span>
                  <span>{t("Base ")}<strong>{t(({ gross: "Salaire brut", ahv_salary: "Salaire soumis AVS", coordinated: "Salaire coordonné", custom: "Base personnalisée" } as const)[definition.basisKind])}</strong>
                  </span>
                  {definition.category === 'lpp' ? (
                    <>
                      <span>{t("Collaborateur")}{' '}
                        <strong>{employee?.name ?? 'Non retrouvé'}</strong>
                      </span>
                      <span>{t("Composante")}{' '}
                        <strong>
                          {definition.lppComponent
                            ? t(lppComponentLabels[definition.lppComponent])
                            : t("Non renseignée")}
                        </strong>
                      </span>
                    </>
                  ) : (
                    <span>{t("Plafond annuel")}{' '}
                      <strong>
                        {definition.annualCeilingCents
                          ? t("{v0} CHF", { v0: (definition.annualCeilingCents / 100).toLocaleString(getAppLocale()) })
                          : t("aucun")}
                      </strong>
                    </span>
                  )}
                  <span>{t("Effet")}{' '}
                    <strong>
                      {definition.effectiveFrom}
                      {definition.effectiveTo
                        ? ` → ${definition.effectiveTo}`
                        : ''}
                    </strong>
                  </span>
                </div>
                <p>
                  <ShieldCheck size={14} />{' '}
                  {definition.source || 'Source non renseignée'}
                </p>
                <footer>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => setDraft(definition)}
                  >{t("Modifier")}</Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("Supprimer {v0}", { v0: definition.label })}
                    onClick={() => {
                      if (
                        !window.confirm(
                          t("Supprimer la définition « {name} » ?", { name: definition.label }),
                        )
                      )
                        return;
                      void run(async () => {
                        await desktopApi.deletePayrollContributionDefinition(
                          definition.id,
                        );
                        await load();
                      }, 'La définition inutilisée a été supprimée.');
                    }}
                  >
                    <Archive size={15} />
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title={t("Aucune cotisation définie")}
          text={t("Installez explicitement le profil CH-2026 ou créez les définitions validées par votre fiduciaire.")}
        />
      )}
    </section>
  );
}

export function contributionDraftPayload(
  form: FormData,
  options: {
    id?: string;
    category: PayrollContributionDefinition['category'];
    calculationKind: PayrollContributionDefinition['calculationKind'];
  },
): Omit<PayrollContributionDefinition, 'id'> & { id?: string } {
  const lpp = options.category === 'lpp';
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const calculationKind = lpp ? 'fixed' : options.calculationKind;
  const payload = {
    id: options.id,
    code: text('code').trim().toUpperCase(),
    label: text('label').trim(),
    category: options.category,
    side: text('side') as PayrollContributionDefinition['side'],
    calculationKind,
    rateBp:
      calculationKind === 'rate'
        ? Math.round(Number(form.get('rate')) * 100)
        : null,
    fixedAmountCents:
      calculationKind === 'fixed'
        ? centsFromInput(form.get('fixedAmount'))
        : null,
    annualCeilingCents:
      !lpp && form.get('annualCeiling')
        ? centsFromInput(form.get('annualCeiling'))
        : null,
    basisKind: text('basisKind') as PayrollContributionDefinition['basisKind'],
    lppComponent: lpp ? (text('lppComponent') as LppComponent) : null,
    lppEmployeeId: lpp ? text('lppEmployeeId') : null,
    source: text('source').trim(),
    effectiveFrom: text('effectiveFrom'),
    effectiveTo: text('effectiveTo'),
    active: text('active') === 'yes',
    liabilityAccountId: text('liabilityAccountId'),
    expenseAccountId: text('expenseAccountId'),
  };
  return payload as Omit<PayrollContributionDefinition, 'id'> & {
    id?: string;
  };
}

function ContributionForm({
  draft,
  accounts,
  employees,
  lppRegulationReference,
  busy,
  onCancel,
  onSubmit,
}: {
  draft: Partial<PayrollContributionDefinition>;
  accounts: Account[];
  employees: Employee[];
  lppRegulationReference: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (
    input: Omit<PayrollContributionDefinition, 'id'> & { id?: string },
  ) => void;
}) {
  useAppLanguage();
  const fieldGuide = usePayrollFieldGuide();
  const [category, setCategory] = useState<
    PayrollContributionDefinition['category'] | ''
  >(draft.category ?? '');
  const [kind, setKind] = useState<
    PayrollContributionDefinition['calculationKind'] | ''
  >(draft.category === 'lpp' ? 'fixed' : (draft.calculationKind ?? ''));
  const isLpp = category === 'lpp';

  return (
    <form
      className="contribution-form"
      noValidate
      onSubmit={event => {
        if (busy || !fieldGuide.check(event.currentTarget)) { event.preventDefault(); return; }
        const element = event.currentTarget;
        return submitForm(async (form) => {
        if (!category || !kind) return;
        const input = contributionDraftPayload(form, {
          id: draft.id,
          category,
          calculationKind: kind,
        });
        if (isLpp && (input.fixedAmountCents ?? 0) <= 0) {
          const field = element.querySelector<HTMLInputElement>('[name="fixedAmount"]');
          if (field) fieldGuide.reject(field, 'Le montant fixe LPP doit être strictement positif.');
          return;
        }
        onSubmit(input);
      })(event);}}
    >
      {fieldGuide.guide}
      {isLpp ? (
        <div className="warning-card contribution-form__guidance">
          <ShieldCheck size={19} />
          <div>
            <strong>{t("Montant individuel du règlement réel")}</strong>
            <p>{t("Saisissez le montant mensuel confirmé pour ce collaborateur. Ne convertissez pas un taux générique et ne déduisez rien du salaire du mois.")}</p>
            {!lppRegulationReference ? (
              <p role="alert">{t("Configurez d’abord la caisse, le contrat et la référence du règlement LPP dans la section « Organismes et validation ».")}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="form-grid">
        <Field label={t("Code unique")} required>
          <input name="code" defaultValue={draft.code} required />
        </Field>
        <Field label={t("Libellé")} required>
          <input name="label" defaultValue={draft.label} required />
        </Field>
        <Field label={t("Catégorie")} required>
          <PayrollSelect
            name="category"
            value={category}
            onChange={(event) => {
              const next = event.target.value as
                | PayrollContributionDefinition['category']
                | '';
              setCategory(next);
              if (next === 'lpp') setKind('fixed');
            }}
            required
          >
            <option value="">{t("Choisir")}</option>
            {Object.entries(categoryLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </PayrollSelect>
        </Field>
        <Field label={t("Part")} required>
          <PayrollSelect name="side" defaultValue={draft.side ?? ''} required>
            <option value="">{t("Choisir")}</option>
            <option value="employee">{t("Employé")}</option>
            <option value="employer">{t("Employeur")}</option>
          </PayrollSelect>
        </Field>
        <Field
          label={t("Mode de calcul")}
          required
          hint={
            isLpp
              ? t("La LPP utilise uniquement le montant individuel du règlement.")
              : undefined
          }
        >
          <PayrollSelect
            value={isLpp ? 'fixed' : kind}
            onChange={(event) =>
              setKind(
                event.target.value as
                  | PayrollContributionDefinition['calculationKind']
                  | '',
              )
            }
            disabled={isLpp}
            required
          >
            <option value="">{t("Choisir")}</option>
            <option value="rate">{t("Taux")}</option>
            <option value="fixed">{t("Montant fixe")}</option>
          </PayrollSelect>
        </Field>
        {!isLpp && kind === 'rate' ? (
          <Field label={t("Taux (%)")} required>
            <input
              name="rate"
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              defaultValue={
                draft.rateBp !== null && draft.rateBp !== undefined
                  ? draft.rateBp / 100
                  : ''
              }
              required
            />
          </Field>
        ) : null}
        {kind === 'fixed' || isLpp ? (
          <Field
            label={
              isLpp
                ? t("Montant mensuel du règlement (CHF)")
                : t("Montant fixe (CHF)")
            }
            required
          >
            <input
              name="fixedAmount"
              type="number"
              min="0.01"
              step="0.01"
              defaultValue={
                draft.fixedAmountCents !== null &&
                draft.fixedAmountCents !== undefined
                  ? draft.fixedAmountCents / 100
                  : ''
              }
              required
            />
          </Field>
        ) : null}
        {isLpp ? (
          <>
            <Field label={t("Collaborateur concerné")} required>
              <PayrollSelect
                name="lppEmployeeId"
                defaultValue={draft.lppEmployeeId ?? ''}
                required
              >
                <option value="">{t("Choisir le collaborateur")}</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                    {employee.employeeNumber
                      ? ` · ${employee.employeeNumber}`
                      : ''}
                    {!employee.active ? t(" · inactif") : ''}
                  </option>
                ))}
              </PayrollSelect>
            </Field>
            <Field label={t("Composante du règlement")} required>
              <PayrollSelect
                name="lppComponent"
                defaultValue={draft.lppComponent ?? ''}
                required
              >
                <option value="">{t("Choisir la composante")}</option>
                {Object.entries(lppComponentLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {t(label)}
                  </option>
                ))}
              </PayrollSelect>
            </Field>
          </>
        ) : null}
        <Field
          label={t("Base")}
          required
          hint={
            isLpp
              ? t("Le montant reste fixe; la base documente le salaire coordonné ou la base propre au règlement.")
              : undefined
          }
        >
          <PayrollSelect
            name="basisKind"
            defaultValue={draft.basisKind ?? ''}
            required
          >
            <option value="">{t("Choisir")}</option>
            {!isLpp ? (
              <>
                <option value="gross">{t("Salaire brut")}</option>
                <option value="ahv_salary">{t("Salaire soumis AVS")}</option>
              </>
            ) : null}
            <option value="coordinated">{t("Salaire coordonné")}</option>
            <option value="custom">{t("Base personnalisée")}</option>
          </PayrollSelect>
        </Field>
        {!isLpp ? (
          <Field
            label={t("Plafond annuel (CHF)")}
            hint={t("Laissez vide si aucun plafond.")}
          >
            <input
              name="annualCeiling"
              type="number"
              min="0.01"
              step="0.01"
              defaultValue={
                draft.annualCeilingCents ? draft.annualCeilingCents / 100 : ''
              }
            />
          </Field>
        ) : null}
        <Field label={t("Date d’effet")} required>
          <input
            name="effectiveFrom"
            type="date"
            defaultValue={draft.effectiveFrom}
            required
          />
        </Field>
        <Field label={t("Fin d’effet")} required={isLpp}>
          <input
            name="effectiveTo"
            type="date"
            defaultValue={draft.effectiveTo}
            required={isLpp}
          />
        </Field>
        <Field
          label={t("Source / référence")}
          required
          wide
          hint={
            isLpp
              ? lppRegulationReference
                ? t("Doit être exactement : {v0}", { v0: lppRegulationReference })
                : t("Doit être exactement la référence du règlement LPP enregistrée dans Paramètres.")
              : undefined
          }
        >
          <input
            name="source"
            defaultValue={draft.source}
            placeholder={isLpp ? lppRegulationReference : undefined}
            required
          />
        </Field>
        <Field label={t("Statut")} required>
          <PayrollSelect
            name="active"
            defaultValue={draft.id ? (draft.active ? 'yes' : 'no') : ''}
            required
          >
            <option value="">{t("Choisir")}</option>
            <option value="yes">{t("Active")}</option>
            <option value="no">{t("Inactive")}</option>
          </PayrollSelect>
        </Field>
        <Field
          label={t("Compte de dette")}
          hint={t("Seuls les comptes actifs de passif sont proposés.")}
        >
          <PayrollSelect
            name="liabilityAccountId"
            defaultValue={draft.liabilityAccountId}
          >
            <option value="">{t("Non lié")}</option>
            {accounts
              .filter(
                (account) =>
                  account.active && account.accountType === 'liability',
              )
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
          </PayrollSelect>
        </Field>
        <Field
          label={t("Compte de charge employeur")}
          hint={t("Seuls les comptes actifs de charges sont proposés; laissez vide pour une part employé.")}
        >
          <PayrollSelect name="expenseAccountId" defaultValue={draft.expenseAccountId}>
            <option value="">{t("Non lié")}</option>
            {accounts
              .filter(
                (account) =>
                  account.active && account.accountType === 'expense',
              )
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
          </PayrollSelect>
        </Field>
      </div>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>{t("Annuler")}</Button>
        <Button
          type="submit"
          disabled={busy || (isLpp && !lppRegulationReference)}
          title={
            isLpp && !lppRegulationReference
              ? t("Configurez d’abord le règlement LPP dans Paramètres.")
              : undefined
          }
        >{t("Enregistrer la définition")}</Button>
      </div>
    </form>
  );
}
