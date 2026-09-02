import { useEffect, useState } from 'react';
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
  ErrorPanel,
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

export function PayrollContributionsPanel() {
  const [definitions, setDefinitions] = useState<
    PayrollContributionDefinition[]
  >([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [lppRegulationReference, setLppRegulationReference] = useState('');
  const [draft, setDraft] = useState<
    Partial<PayrollContributionDefinition> | null
  >(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
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
  }

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (success) setNotice(success);
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'La cotisation n’a pas pu être enregistrée.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(load);
  }, []);

  return (
    <section className="panel settings-card settings-card--wide payroll-definitions">
      <SectionHeading
        eyebrow="Moteur de paie"
        title="Définitions de cotisations"
        description="Chaque base, montant, plafond, part, source et période d’effet est conservé explicitement."
        action={
          <div className="heading-actions">
            <Button
              variant="ghost"
              size="small"
              onClick={() => void run(load)}
            >
              <RefreshCw size={14} /> Actualiser
            </Button>
            <Button size="small" onClick={() => setDraft({})}>
              <Plus size={14} /> Nouvelle cotisation
            </Button>
          </div>
        }
      />
      {error ? <ErrorPanel message={error} /> : null}
      {notice ? (
        <div className="notice notice--success">
          <span>
            <CheckCircle2 size={17} />
            {notice}
          </span>
          <button aria-label="Masquer le message" onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      ) : null}
      {draft ? (
        <ContributionForm
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
                      {categoryLabels[definition.category]} · part{' '}
                      {definition.side === 'employee'
                        ? 'employé'
                        : 'employeur'}
                    </small>
                  </div>
                  <StatusBadge
                    status={definition.active ? 'validated' : 'incomplete'}
                  />
                </header>
                <div className="contribution-facts">
                  <span>
                    Calcul{' '}
                    <strong>
                      {definition.calculationKind === 'rate'
                        ? `${((definition.rateBp ?? 0) / 100).toLocaleString('fr-CH')} %`
                        : `${((definition.fixedAmountCents ?? 0) / 100).toLocaleString('fr-CH')} CHF`}
                    </strong>
                  </span>
                  <span>
                    Base <strong>{definition.basisKind}</strong>
                  </span>
                  {definition.category === 'lpp' ? (
                    <>
                      <span>
                        Collaborateur{' '}
                        <strong>{employee?.name ?? 'Non retrouvé'}</strong>
                      </span>
                      <span>
                        Composante{' '}
                        <strong>
                          {definition.lppComponent
                            ? lppComponentLabels[definition.lppComponent]
                            : 'Non renseignée'}
                        </strong>
                      </span>
                    </>
                  ) : (
                    <span>
                      Plafond annuel{' '}
                      <strong>
                        {definition.annualCeilingCents
                          ? `${(definition.annualCeilingCents / 100).toLocaleString('fr-CH')} CHF`
                          : 'aucun'}
                      </strong>
                    </span>
                  )}
                  <span>
                    Effet{' '}
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
                  >
                    Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Supprimer ${definition.label}`}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Supprimer la définition « ${definition.label} » ?`,
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
          title="Aucune cotisation définie"
          text="Installez explicitement le profil CH-2026 ou créez les définitions validées par votre fiduciaire."
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
  const calculationKind = lpp ? 'fixed' : options.calculationKind;
  const payload = {
    id: options.id,
    code: String(form.get('code')).trim().toUpperCase(),
    label: String(form.get('label')).trim(),
    category: options.category,
    side: String(form.get('side')) as PayrollContributionDefinition['side'],
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
    basisKind: String(
      form.get('basisKind'),
    ) as PayrollContributionDefinition['basisKind'],
    lppComponent: lpp
      ? (String(form.get('lppComponent')) as LppComponent)
      : null,
    lppEmployeeId: lpp ? String(form.get('lppEmployeeId')) : null,
    source: String(form.get('source')).trim(),
    effectiveFrom: String(form.get('effectiveFrom')),
    effectiveTo: String(form.get('effectiveTo')),
    active: String(form.get('active')) === 'yes',
    liabilityAccountId: String(form.get('liabilityAccountId')),
    expenseAccountId: String(form.get('expenseAccountId')),
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
      onSubmit={submitForm(async (form) => {
        if (!category || !kind) return;
        const input = contributionDraftPayload(form, {
          id: draft.id,
          category,
          calculationKind: kind,
        });
        if (isLpp && (input.fixedAmountCents ?? 0) <= 0)
          throw new Error(
            'Le montant fixe LPP doit être strictement positif.',
          );
        onSubmit(input);
      })}
    >
      {isLpp ? (
        <div className="warning-card contribution-form__guidance">
          <ShieldCheck size={19} />
          <div>
            <strong>Montant individuel du règlement réel</strong>
            <p>
              Saisissez le montant mensuel confirmé pour ce collaborateur. Ne
              convertissez pas un taux générique et ne déduisez rien du salaire
              du mois.
            </p>
            {!lppRegulationReference ? (
              <p role="alert">
                Configurez d’abord la caisse, le contrat et la référence du
                règlement LPP dans la section « Organismes et validation ».
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="form-grid">
        <Field label="Code unique" required>
          <input name="code" defaultValue={draft.code} required />
        </Field>
        <Field label="Libellé" required>
          <input name="label" defaultValue={draft.label} required />
        </Field>
        <Field label="Catégorie" required>
          <select
            name="category"
            value={category}
            onChange={(event) => {
              const next = event.target
                .value as PayrollContributionDefinition['category'] | '';
              setCategory(next);
              if (next === 'lpp') setKind('fixed');
            }}
            required
          >
            <option value="">Choisir</option>
            {Object.entries(categoryLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Part" required>
          <select name="side" defaultValue={draft.side ?? ''} required>
            <option value="">Choisir</option>
            <option value="employee">Employé</option>
            <option value="employer">Employeur</option>
          </select>
        </Field>
        <Field
          label="Mode de calcul"
          required
          hint={
            isLpp
              ? 'La LPP utilise uniquement le montant individuel du règlement.'
              : undefined
          }
        >
          <select
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
            <option value="">Choisir</option>
            <option value="rate">Taux</option>
            <option value="fixed">Montant fixe</option>
          </select>
        </Field>
        {!isLpp && kind === 'rate' ? (
          <Field label="Taux (%)" required>
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
                ? 'Montant mensuel du règlement (CHF)'
                : 'Montant fixe (CHF)'
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
            <Field label="Collaborateur concerné" required>
              <select
                name="lppEmployeeId"
                defaultValue={draft.lppEmployeeId ?? ''}
                required
              >
                <option value="">Choisir le collaborateur</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                    {employee.employeeNumber
                      ? ` · ${employee.employeeNumber}`
                      : ''}
                    {!employee.active ? ' · inactif' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Composante du règlement" required>
              <select
                name="lppComponent"
                defaultValue={draft.lppComponent ?? ''}
                required
              >
                <option value="">Choisir la composante</option>
                {Object.entries(lppComponentLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}
        <Field
          label="Base"
          required
          hint={
            isLpp
              ? 'Le montant reste fixe; la base documente le salaire coordonné ou la base propre au règlement.'
              : undefined
          }
        >
          <select name="basisKind" defaultValue={draft.basisKind ?? ''} required>
            <option value="">Choisir</option>
            {!isLpp ? (
              <>
                <option value="gross">Salaire brut</option>
                <option value="ahv_salary">Salaire soumis AVS</option>
              </>
            ) : null}
            <option value="coordinated">Salaire coordonné</option>
            <option value="custom">Base personnalisée</option>
          </select>
        </Field>
        {!isLpp ? (
          <Field
            label="Plafond annuel (CHF)"
            hint="Laissez vide si aucun plafond."
          >
            <input
              name="annualCeiling"
              type="number"
              min="0.01"
              step="0.01"
              defaultValue={
                draft.annualCeilingCents
                  ? draft.annualCeilingCents / 100
                  : ''
              }
            />
          </Field>
        ) : null}
        <Field label="Date d’effet" required>
          <input
            name="effectiveFrom"
            type="date"
            defaultValue={draft.effectiveFrom}
            required
          />
        </Field>
        <Field label="Fin d’effet" required={isLpp}>
          <input
            name="effectiveTo"
            type="date"
            defaultValue={draft.effectiveTo}
            required={isLpp}
          />
        </Field>
        <Field
          label="Source / référence"
          required
          wide
          hint={
            isLpp
              ? lppRegulationReference
                ? `Doit être exactement : ${lppRegulationReference}`
                : 'Doit être exactement la référence du règlement LPP enregistrée dans Paramètres.'
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
        <Field label="Statut" required>
          <select
            name="active"
            defaultValue={draft.id ? (draft.active ? 'yes' : 'no') : ''}
            required
          >
            <option value="">Choisir</option>
            <option value="yes">Active</option>
            <option value="no">Inactive</option>
          </select>
        </Field>
        <Field
          label="Compte de dette"
          hint="Seuls les comptes actifs de passif sont proposés."
        >
          <select
            name="liabilityAccountId"
            defaultValue={draft.liabilityAccountId}
          >
            <option value="">Non lié</option>
            {accounts
              .filter(
                (account) => account.active && account.accountType === 'liability',
              )
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
          </select>
        </Field>
        <Field
          label="Compte de charge employeur"
          hint="Seuls les comptes actifs de charges sont proposés; laissez vide pour une part employé."
        >
          <select
            name="expenseAccountId"
            defaultValue={draft.expenseAccountId}
          >
            <option value="">Non lié</option>
            {accounts
              .filter(
                (account) => account.active && account.accountType === 'expense',
              )
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Annuler
        </Button>
        <Button
          type="submit"
          disabled={busy || (isLpp && !lppRegulationReference)}
          title={
            isLpp && !lppRegulationReference
              ? 'Configurez d’abord le règlement LPP dans Paramètres.'
              : undefined
          }
        >
          Enregistrer la définition
        </Button>
      </div>
    </form>
  );
}
