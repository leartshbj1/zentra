import { useEffect, useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { Button, Field, submitForm } from './ui';
import { createId, centsFromInput, errorMessage } from './utils';
import { PayrollProblem } from './PayrollProblem';
import {
  CONTRACT_PRESETS,
  contractContribution,
  singlePayrollAccount,
  missingFederalContributions,
  type ContractPreset,
} from './payrollContractPresets';
import type {
  Account,
  PayrollContributionDefinition,
  Workspace,
} from './types';

export function PayrollContractSetup({
  workspace,
  employeeId,
  period,
  busy,
  act,
  onSaved,
}: {
  workspace: Workspace;
  employeeId: string;
  period: string;
  busy: boolean;
  act: (
    action: () => Promise<Workspace>,
    message: string,
    close?: boolean,
    onError?: (reason: unknown) => void,
  ) => Promise<boolean>;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState<ContractPreset>('aap');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [definitions, setDefinitions] = useState<
    PayrollContributionDefinition[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [id, setId] = useState(createId);
  const [editing, setEditing] = useState<PayrollContributionDefinition | null>(
    null,
  );
  const lock = useRef(false);
  const year = Number(period.slice(0, 4));
  const pension = category === 'lpp';
  const preset = CONTRACT_PRESETS[category];
  useEffect(() => {
    let alive = true;
    void Promise.all([
      desktopApi.listAccounts(),
      desktopApi.listPayrollContributionDefinitions(),
    ])
      .then(([a, d]) => {
        if (alive) {
          setAccounts(a);
          setDefinitions(d);
          setError('');
        }
      })
      .catch((reason) => {
        if (alive)
          setError(
            errorMessage(reason, 'Les cotisations ne sont pas disponibles.'),
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  async function run(action: () => Promise<Workspace>) {
    if (lock.current || busy || loading) return;
    lock.current = true;
    setError('');
    try {
      const ok = await act(
        action,
        'Les cotisations ont été enregistrées.',
        false,
        (reason) =>
          setError(
            errorMessage(reason, 'La cotisation n’a pas pu être enregistrée.'),
          ),
      );
      if (ok) {
        setEditing(null);
        setId(createId());
        setLoading(true);
        setRevision((value) => value + 1);
        onSaved();
      }
    } finally {
      lock.current = false;
    }
  }
  const existing = definitions.filter(
    (d) =>
      d.active &&
      d.category === category &&
      (!pension || d.lppEmployeeId === employeeId) &&
      d.effectiveFrom <= `${period}-01` &&
      (!d.effectiveTo || d.effectiveTo >= `${period}-01`),
  );
  const editable = (d: PayrollContributionDefinition) =>
    d.effectiveFrom.startsWith('2026-') &&
    d.effectiveTo.startsWith('2026-') &&
    d.basisKind === (pension ? 'coordinated' : 'ahv_salary') &&
    (pension ? d.calculationKind === 'fixed' : d.calculationKind === 'rate') &&
    (category !== 'aanp' || d.side === 'employee') &&
    (!['aap', 'family_allowance'].includes(category) || d.side === 'employer');
  return (
    <section className="payroll-contracts">
      <div>
        <h3>Cotisations et assurances</h3>
        <p>
          Recopiez votre contrat. Ces réglages seront réutilisables chaque mois.
        </p>
      </div>
      {error && (
        <>
          <PayrollProblem messages={[error]} reveal />
          <Button
            type="button"
            variant="ghost"
            disabled={busy || loading}
            onClick={() => {
              setLoading(true);
              setRevision((value) => value + 1);
            }}
          >
            Actualiser les cotisations
          </Button>
        </>
      )}
      <details className="payroll-simple-guide">
        <summary>Taux suisses AVS et chômage</summary>
        <p>
          Préparez les cotisations fédérales avec le référentiel suisse 2026
          inclus. Les cotisations déjà présentes restent conservées.
        </p>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || loading || year !== 2026}
          onClick={() =>
            void run(async () => {
              const [profiles, current] = await Promise.all([
                desktopApi.getPayrollRegulatoryProfiles(),
                desktopApi.listPayrollContributionDefinitions(),
              ]);
              const profile = profiles.find((p) => p.id === 'CH-2026');
              if (!profile)
                throw new Error(
                  'Les taux suisses 2026 ne sont pas disponibles dans cette version.',
                );
              for (const definition of missingFederalContributions(
                profile.definitions,
                current,
              )) {
                await desktopApi.upsertPayrollContributionDefinition({
                  ...definition,
                  liabilityAccountId: singlePayrollAccount(
                    accounts,
                    'liability',
                  ),
                  expenseAccountId:
                    definition.side === 'employer'
                      ? singlePayrollAccount(accounts, 'expense')
                      : '',
                });
              }
              return desktopApi.loadWorkspace();
            })
          }
        >
          Préparer les cotisations suisses 2026
        </Button>
      </details>
      <Field label="Quelle cotisation souhaitez-vous préparer ?">
        <select
          value={category}
          disabled={busy}
          onChange={(event) => {
            setCategory(event.target.value as ContractPreset);
            setEditing(null);
            setId(createId());
          }}
        >
          {Object.entries(CONTRACT_PRESETS).map(([key, item]) => (
            <option key={key} value={key}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      <p>{preset.explanation}</p>
      {existing.length > 0 && (
        <div className="payroll-callout">
          <strong>Déjà enregistré pour cette période</strong>
          {existing.map((d) => (
            <div key={d.id}>
              <span>
                {d.label} · {d.side === 'employee' ? 'salarié' : 'entreprise'} ·{' '}
                {d.rateBp == null
                  ? `${((d.fixedAmountCents ?? 0) / 100).toLocaleString('fr-CH')} CHF`
                  : `${(d.rateBp / 100).toLocaleString('fr-CH')} %`}
              </span>
              {editable(d) ? (
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  disabled={busy || loading}
                  onClick={() => {
                    setEditing(structuredClone(d));
                    setId(d.id);
                  }}
                >
                  Modifier {d.label}
                </Button>
              ) : (
                <small>
                  Cette couverture particulière se modifie dans Paramètres →
                  Paie → Cotisations.
                </small>
              )}
            </div>
          ))}
          <small>
            Ajoutez une ligne uniquement si elle correspond à une autre part ou
            couverture.
          </small>
        </div>
      )}
      {editing && (
        <output>
          Modification de {editing.label}.{' '}
          <Button
            type="button"
            variant="ghost"
            size="small"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setId(createId());
            }}
          >
            Annuler la modification
          </Button>
        </output>
      )}
      <form
        key={`${category}-${id}`}
        onSubmit={(event) =>
          submitForm(async (form) => {
            try {
              const text = (name: string) => {
                const value = form.get(name);
                return typeof value === 'string' ? value : '';
              };
              const input = contractContribution({
                id,
                category,
                side: text('side') as 'employee' | 'employer',
                rate: text('rate'),
                amountCents: pension ? centsFromInput(form.get('amount')) : 0,
                employeeId,
                component: pension
                  ? (text('component') as 'risk' | 'savings' | 'combined')
                  : null,
                source: text('source'),
                from: text('from'),
                to: text('to'),
                liability: text('liability'),
                expense: text('expense'),
              });
              const desired = editing
                ? { ...input, code: editing.code, label: editing.label }
                : input;
              await run(async () => {
                if (editing) {
                  const fresh = (
                    await desktopApi.listPayrollContributionDefinitions()
                  ).find((d) => d.id === editing.id);
                  const same = (
                    a: PayrollContributionDefinition | undefined,
                    b: PayrollContributionDefinition,
                  ) =>
                    a &&
                    Object.keys(b).every(
                      (key) =>
                        a[key as keyof typeof a] === b[key as keyof typeof b],
                    );
                  if (same(fresh, desired)) return desktopApi.loadWorkspace();
                  if (!same(fresh, editing))
                    throw new Error(
                      'Cette cotisation a changé. Actualisez la liste avant de la modifier.',
                    );
                }
                await desktopApi.upsertPayrollContributionDefinition(desired);
                return desktopApi.loadWorkspace();
              });
            } catch (reason) {
              setError(
                errorMessage(reason, 'Vérifiez les informations du contrat.'),
              );
            }
          })(event)
        }
      >
        <fieldset disabled={busy || loading || year !== 2026}>
          <div className="form-grid">
            <Field label="Qui paie cette part ?" required>
              <select
                name="side"
                defaultValue={editing?.side ?? preset.side}
                required
              >
                <option value={preset.side}>
                  {preset.side === 'employee'
                    ? 'Le salarié : retenue sur son salaire'
                    : 'L’entreprise : charge en plus du salaire'}
                </option>
                {(pension || category === 'ijm') && (
                  <option value="employer">
                    L’entreprise : charge en plus du salaire
                  </option>
                )}
              </select>
            </Field>
            {pension ? (
              <Field label="Montant mensuel du certificat (CHF)" required>
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  defaultValue={
                    editing?.fixedAmountCents == null
                      ? ''
                      : editing.fixedAmountCents / 100
                  }
                  required
                />
              </Field>
            ) : (
              <Field
                label="Taux exact de cette part (%)"
                required
                hint="Exemple de saisie : 1.25 pour 1,25 %. Recopiez le taux de votre contrat."
              >
                <input
                  name="rate"
                  inputMode="decimal"
                  defaultValue={
                    editing?.rateBp == null ? '' : editing.rateBp / 100
                  }
                  required
                />
              </Field>
            )}
            {pension && (
              <Field label="Ce montant couvre" required>
                <select
                  name="component"
                  required
                  defaultValue={editing?.lppComponent ?? ''}
                >
                  <option value="">Lire le certificat de prévoyance</option>
                  <option value="combined">Épargne et risques réunis</option>
                  <option value="risk">
                    Risques uniquement (décès et invalidité)
                  </option>
                  <option value="savings">Épargne uniquement</option>
                </select>
              </Field>
            )}
            <Field label="Début du tarif" required>
              <input
                type="date"
                name="from"
                min="2026-01-01"
                max="2026-12-31"
                defaultValue={editing?.effectiveFrom}
                required
              />
            </Field>
            <Field label="Fin de la période confirmée" required>
              <input
                type="date"
                name="to"
                min="2026-01-01"
                max="2026-12-31"
                defaultValue={editing?.effectiveTo}
                required
              />
            </Field>
            <Field
              label={
                pension
                  ? 'Référence du règlement de pension'
                  : 'Référence du contrat ou du décompte'
              }
              required
              wide
              hint={
                pension
                  ? 'Reprenez exactement la référence enregistrée avec la caisse de pension.'
                  : 'Assureur ou caisse, numéro de contrat et année : de quoi retrouver le taux.'
              }
            >
              <input
                name="source"
                minLength={8}
                maxLength={500}
                required
                defaultValue={
                  editing?.source ??
                  (pension
                    ? workspace.settings?.payroll.lppPlanEvidence
                        ?.regulationReference
                    : '')
                }
              />
            </Field>
          </div>
          <div className="payroll-contract-summary">
            <dl>
              <dt>Calcul prévu</dt>
              <dd>
                {pension
                  ? 'Montant mensuel confirmé'
                  : 'Taux × salaire soumis à cotisation'}
              </dd>
              {['aap', 'aanp'].includes(category) && (
                <>
                  <dt>Plafond accidents 2026</dt>
                  <dd>CHF 148’200 par an</dd>
                </>
              )}
            </dl>
            <small>
              {pension
                ? 'La base légale de pension est contrôlée à partir du salaire annuel confirmé.'
                : 'Les allocations familiales légales restent exclues du salaire soumis aux cotisations. Confirmez que votre contrat utilise cette base.'}
            </small>
          </div>
          <details className="payroll-simple-guide">
            <summary>Comptes pour la comptabilité</summary>
            <p>
              Choisissez les comptes correspondant à cette cotisation. Ces choix
              ne modifient pas le net à payer.
            </p>
            <Field label="Cotisations à payer">
              <select
                name="liability"
                defaultValue={
                  editing
                    ? (editing.liabilityAccountId ?? '')
                    : singlePayrollAccount(accounts, 'liability')
                }
              >
                <option value="">À compléter avant comptabilisation</option>
                {editing?.liabilityAccountId &&
                  !accounts.some(
                    (a) =>
                      a.id === editing.liabilityAccountId &&
                      a.active &&
                      a.accountType === 'liability',
                  ) && (
                    <option value={editing.liabilityAccountId}>
                      Compte actuel indisponible — à remplacer
                    </option>
                  )}
                {accounts
                  .filter((a) => a.active && a.accountType === 'liability')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Charges de personnel (part entreprise)">
              <select
                name="expense"
                defaultValue={
                  editing
                    ? (editing.expenseAccountId ?? '')
                    : singlePayrollAccount(accounts, 'expense')
                }
              >
                <option value="">À compléter avant comptabilisation</option>
                {editing?.expenseAccountId &&
                  !accounts.some(
                    (a) =>
                      a.id === editing.expenseAccountId &&
                      a.active &&
                      a.accountType === 'expense',
                  ) && (
                    <option value={editing.expenseAccountId}>
                      Compte actuel indisponible — à remplacer
                    </option>
                  )}
                {accounts
                  .filter((a) => a.active && a.accountType === 'expense')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
              </select>
            </Field>
          </details>
          <label className="check-card">
            <input type="checkbox" required />
            <span>
              J’ai vérifié la part, le montant, les dates et la base sur mon
              contrat.{' '}
              {editing
                ? 'Les prochaines fiches utiliseront ces réglages ; les fiches déjà comptabilisées restent figées.'
                : 'Cette cotisation s’ajoute à celles déjà enregistrées.'}
            </span>
          </label>
          <Button
            type="submit"
            disabled={busy || loading || (pension && !employeeId)}
          >
            {editing
              ? 'Enregistrer la modification'
              : 'Enregistrer cette cotisation'}
          </Button>
        </fieldset>
      </form>
      {year !== 2026 && (
        <p>
          Les réglages guidés couvrent 2026. Pour une autre année, utilisez les
          paramètres détaillés et le référentiel correspondant.
        </p>
      )}
    </section>
  );
}
