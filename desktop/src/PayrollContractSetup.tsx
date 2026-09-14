import { t, useAppLanguage, getAppLocale } from './language';
import { PayrollSelect } from './PayrollSelect';
import { useEffect, useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { Button, Field, submitForm } from './ui';
import { createId, centsFromInput, errorMessage } from './utils';
import { PayrollProblem } from './PayrollProblem';
import { usePayrollFieldGuide } from './PayrollFieldGuide';
import type { PayrollHelpTarget } from './payrollHelp';
import { revealPayrollField } from './payrollNavigation';
import { pensionPlanComplete } from './payrollPension';
import { PayrollPensionPair } from './PayrollPensionPair';
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
  contributionDate,
  busy,
  act,
  onSaved,
  destination,
  onFix,
  guided = false,
}: {
  workspace: Workspace;
  employeeId: string;
  period: string;
  contributionDate?: string;
  busy: boolean;
  act: (
    action: () => Promise<Workspace>,
    message: string,
    close?: boolean,
    onError?: (reason: unknown) => void,
  ) => Promise<boolean>;
  onSaved: (definitionIds?: readonly string[]) => void;
  destination?: {
    target: PayrollHelpTarget;
    selector?: string;
    revision: number;
  };
  guided?: boolean;
  onFix?: (target: PayrollHelpTarget, selector?: string) => void;
}) {
  useAppLanguage();
  const directedPreset = Object.keys(CONTRACT_PRESETS).find(
    (preset) => destination?.selector === `[data-payroll-preset="${preset}"]`,
  ) as ContractPreset | undefined;
  const federalOnly =
    guided && destination?.selector === '[data-payroll-preset="federal"]';
  const [category, setCategory] = useState<ContractPreset>(
    destination?.target === 'pension-contributions'
      ? 'lpp'
      : (directedPreset ?? 'aap'),
  );
  const container = useRef<HTMLElement>(null);
  const [seenDestination, setSeenDestination] = useState(destination);
  useEffect(() => {
    if (destination?.target === 'pension-contributions' && category === 'lpp')
      revealPayrollField(container.current, '[data-pension-guide]');
  }, [category, destination]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [definitions, setDefinitions] = useState<
    PayrollContributionDefinition[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const fieldGuide = usePayrollFieldGuide();
  const [revision, setRevision] = useState(0);
  const [id, setId] = useState(createId);
  const [creatingAnother, setCreatingAnother] = useState(false);
  const [editing, setEditing] = useState<PayrollContributionDefinition | null>(
    null,
  );
  if (destination !== seenDestination) {
    setSeenDestination(destination);
    setCreatingAnother(false);
    if (destination?.target === 'pension-contributions' && category !== 'lpp') {
      setCategory('lpp');
      setEditing(null);
      setId(createId());
    }
    if (directedPreset && directedPreset !== category) {
      setCategory(directedPreset);
      setEditing(null);
      setId(createId());
    }
  }
  const lock = useRef(false);
  const year = Number(period.slice(0, 4));
  const pension = category === 'lpp';
  const preset = CONTRACT_PRESETS[category];
  const employee = workspace.employees.find((e) => e.id === employeeId);
  const planReady = Boolean(
    workspace.settings &&
    pensionPlanComplete(workspace.settings.payroll, period),
  );
  const annualReady =
    employee?.lppAssessmentYear === year &&
    employee.lppAnnualSalaryCents != null;
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
  async function run(action: () => Promise<Workspace>, definitionIds?: readonly string[]) {
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
        setCreatingAnother(false);
        setEditing(null);
        setId(createId());
        setLoading(true);
        setRevision((value) => value + 1);
        onSaved(definitionIds);
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
      d.effectiveFrom <= (contributionDate || `${period}-01`) &&
      (!d.effectiveTo || d.effectiveTo >= (contributionDate || `${period}-01`)),
  );
  const editable = (d: PayrollContributionDefinition) =>
    d.effectiveFrom.startsWith('2026-') &&
    d.effectiveTo.startsWith('2026-') &&
    d.basisKind === (pension ? 'coordinated' : 'ahv_salary') &&
    (pension ? d.calculationKind === 'fixed' : d.calculationKind === 'rate') &&
    (category !== 'aanp' || d.side === 'employee') &&
    (!['aap', 'family_allowance'].includes(category) || d.side === 'employer');
  const pair =
    guided &&
    pension &&
    !editing &&
    planReady &&
    annualReady &&
    existing.length <= 2 &&
    new Set(existing.map((d) => d.side)).size === existing.length &&
    existing.every(editable) &&
    new Set(existing.map((d) => d.lppComponent)).size <= 1 &&
    new Set(existing.map((d) => `${d.effectiveFrom}/${d.effectiveTo}`)).size <=
      1;
  return (
    <section className="payroll-contracts" ref={container}>
      <div>
        <h3>
          {federalOnly
            ? t("Les taux suisses, déjà prêts pour vous")
            : guided
              ? t(preset.label)
              : t("Cotisations et assurances")}
        </h3>
        <p>{t("Recopiez votre contrat. Ces réglages seront réutilisables chaque mois.")}</p>
      </div>
      {error && (
        <>
          <PayrollProblem
            messages={[error]}
            reveal
            disabled={busy || loading}
            onFix={(target, selector) => {
              if (['contributions', 'review', 'salary'].includes(target))
                revealPayrollField(container.current, selector ?? 'form');
              else onFix?.(target, selector);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            disabled={busy || loading}
            onClick={() => {
              setLoading(true);
              setRevision((value) => value + 1);
            }}
          >{t("Actualiser les cotisations")}</Button>
        </>
      )}
      <details
        className="payroll-simple-guide"
        data-payroll-preset="federal"
        open={federalOnly ? true : undefined}
        hidden={guided && !federalOnly}
      >
        <summary>{t("Taux suisses AVS et chômage")}</summary>
        <p>{t("Préparez les cotisations fédérales avec le référentiel suisse 2026 inclus. Les cotisations déjà présentes restent conservées.")}</p>
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
        >{t("Préparer les cotisations suisses 2026")}</Button>
      </details>
      <div hidden={federalOnly}>
        {!guided && (
          <Field label={t("Quelle cotisation souhaitez-vous préparer ?")}>
            <PayrollSelect
              value={category}
              disabled={busy}
              onChange={(event) => {
                fieldGuide.clear();
                setCategory(event.target.value as ContractPreset);
                setEditing(null);
                setId(createId());
              }}
            >
              {Object.entries(CONTRACT_PRESETS).map(([key, item]) => (
                <option key={key} value={key}>
                  {t(item.label)}
                </option>
              ))}
            </PayrollSelect>
          </Field>
        )}
        <p>{t(preset.explanation)}</p>
        {pension && !pair && (
          <section
            className="payroll-pension-guide"
            data-pension-guide
            aria-label={t("Préparer la caisse de pension")}
          >
            <h3>{t("La pension de {name}, en trois points", { name: employee?.name ?? t('votre collaborateur') })}</h3>
            <ol>
              <li>
                <div>
                  <strong>{t("Le salaire annuel")}</strong>
                  <p>
                    {annualReady
                      ? t("Salaire annoncé pour {v0} : CHF {v1}.", { v0: year, v1: ((employee!.lppAnnualSalaryCents ?? 0) / 100).toLocaleString(getAppLocale()) })
                      : t("Recopiez le salaire brut annuel annoncé à la caisse pour cette personne.")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={busy || loading}
                  onClick={() => onFix?.('pension-person')}
                >
                  {annualReady
                    ? t("Vérifier le salaire annuel")
                    : t("Renseigner le salaire annuel")}
                </Button>
              </li>
              <li>
                <div>
                  <strong>{t("Le contrat de la caisse")}</strong>
                  <p>
                    {planReady
                      ? t("{v0} · contrat renseigné.", { v0: workspace.settings!.payroll.pensionFund })
                      : t("Le nom de la caisse, le règlement et ses dates doivent être complétés pour ce mois.")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={busy || loading}
                  onClick={() => onFix?.('pension-plan')}
                >
                  {planReady
                    ? t("Vérifier le contrat de pension")
                    : t("Compléter le contrat de pension")}
                </Button>
              </li>
              <li>
                <div>
                  <strong>{t("Les montants mensuels")}</strong>
                  <p>{t("Recopiez la part du salarié et celle de l’entreprise, une ligne à la fois. Le certificat précise ce qui couvre l’épargne et les risques.")}</p>
                </div>
              </li>
            </ol>
            <small>{t("Vous n’avez pas le certificat ? Demandez à la caisse les montants mensuels des deux parts. Ne remplacez pas un montant inconnu par zéro.")}</small>
          </section>
        )}
        {existing.length > 0 && !pair && (
          <div className="payroll-callout">
            <strong>{t("Déjà enregistré pour cette période")}</strong>
            {guided && <p>{t("Choisissez le contrat de cette personne. Il sera utilisé dans la fiche sans créer une nouvelle cotisation.")}</p>}
            {existing.map((d) => (
              <div key={d.id}>
                <span>
                  {d.label} · {d.side === 'employee' ? t("salarié") : t("entreprise")}{' '}
                  ·{' '}
                  {d.rateBp == null
                    ? t("{v0} CHF", { v0: ((d.fixedAmountCents ?? 0) / 100).toLocaleString(getAppLocale()) })
                    : `${(d.rateBp / 100).toLocaleString(getAppLocale())} %`}
                </span>
                {guided && <Button type="button" size="small" disabled={busy || loading}
                  onClick={() => onSaved([d.id])}>{t("Utiliser cette cotisation")}</Button>}
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
                  >{t("Modifier {name}", { name: d.label })}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    disabled={busy || loading}
                    onClick={() => onFix?.('advanced-contributions')}
                  >{t("Ouvrir les réglages de cette couverture")}</Button>
                )}
              </div>
            ))}
            <small>{t("Ajoutez une ligne uniquement si elle correspond à une autre part ou couverture.")}</small>
          </div>
        )}
        {editing && (
          <output>{t("Modification de {name}.", { name: editing.label })}{' '}
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setId(createId());
              }}
            >{t("Annuler la modification")}</Button>
          </output>
        )}
        {pair && (
          <PayrollPensionPair
            workspace={workspace}
            employeeId={employeeId}
            existing={existing}
            accounts={accounts}
            disabled={busy || loading}
            run={run}
          />
        )}
        {guided && existing.length > 0 && !pair && !editing && !creatingAnother &&
          <Button type="button" variant="ghost" disabled={busy || loading} onClick={() => setCreatingAnother(true)}>
            {t("Ajouter un autre contrat")}
          </Button>}
        <form
          hidden={pair || (guided && existing.length > 0 && !editing && !creatingAnother)}
          noValidate
          key={`${category}-${id}`}
          onSubmit={(event) => {
            if (!fieldGuide.check(event.currentTarget)) {
              event.preventDefault();
              return;
            }
            return submitForm(async (form) => {
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
                if (guided && contributionDate &&
                    (desired.effectiveFrom > contributionDate || (desired.effectiveTo && desired.effectiveTo < contributionDate))) {
                  const field = event.currentTarget.querySelector<HTMLInputElement>(desired.effectiveFrom > contributionDate ? '[name=from]' : '[name=to]');
                  if (field) fieldGuide.reject(field, t('Le contrat doit être valable à la date de paie ({date}). Corrigez ses dates ou choisissez un autre contrat.', { date: contributionDate }));
                  return;
                }
                if (pension && !planReady)
                  throw new Error(
                    'Contrat de pension incomplet : complétez le règlement avant les montants.',
                  );
                if (pension) {
                  const plan = workspace.settings!.payroll.lppPlanEvidence!;
                  if (input.source.trim() !== plan.regulationReference.trim())
                    throw new Error(
                      'La source de chaque définition LPP doit correspondre exactement à la référence du règlement conservée dans les paramètres.',
                    );
                  if (
                    input.effectiveFrom < plan.effectiveFrom ||
                    input.effectiveTo > plan.effectiveTo
                  )
                    throw new Error(
                      'La période d’effet de chaque définition LPP doit rester entièrement comprise dans celle du règlement enregistré.',
                    );
                }
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
                }, [desired.id]);
              } catch (reason) {
                setError(
                  errorMessage(reason, 'Vérifiez les informations du contrat.'),
                );
              }
            })(event);
          }}
        >
          {fieldGuide.guide}
          <fieldset disabled={busy || loading || year !== 2026}>
            <div className="form-grid">
              <Field label={t("Qui paie cette part ?")} required>
                <PayrollSelect
                  name="side"
                  defaultValue={editing?.side ?? preset.side}
                  required
                >
                  <option value={preset.side}>
                    {preset.side === 'employee'
                      ? t("Le salarié : retenue sur son salaire")
                      : t("L’entreprise : charge en plus du salaire")}
                  </option>
                  {(pension || category === 'ijm') && (
                    <option value="employer">{t("L’entreprise : charge en plus du salaire")}</option>
                  )}
                </PayrollSelect>
              </Field>
              {pension ? (
                <Field label={t("Montant mensuel du certificat (CHF)")} required>
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
                  label={t("Taux exact de cette part (%)")}
                  required
                  hint={t("Exemple de saisie : 1.25 pour 1,25 %. Recopiez le taux de votre contrat.")}
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
                <Field label={t("Ce montant couvre")} required>
                  <PayrollSelect
                    name="component"
                    required
                    defaultValue={editing?.lppComponent ?? ''}
                  >
                    <option value="">{t("Lire le certificat de prévoyance")}</option>
                    <option value="combined">{t("Épargne et risques réunis")}</option>
                    <option value="risk">{t("Risques uniquement (décès et invalidité)")}</option>
                    <option value="savings">{t("Épargne uniquement")}</option>
                  </PayrollSelect>
                </Field>
              )}
              <Field label={t("Début du tarif")} required>
                <input
                  type="date"
                  name="from"
                  min="2026-01-01"
                  max="2026-12-31"
                  defaultValue={
                    editing?.effectiveFrom ??
                    (pension && planReady
                      ? workspace.settings?.payroll.lppPlanEvidence
                          ?.effectiveFrom
                      : undefined)
                  }
                  required
                />
              </Field>
              <Field label={t("Fin de la période confirmée")} required>
                <input
                  type="date"
                  name="to"
                  min="2026-01-01"
                  max="2026-12-31"
                  defaultValue={
                    editing?.effectiveTo ??
                    (pension && planReady
                      ? workspace.settings?.payroll.lppPlanEvidence?.effectiveTo
                      : undefined)
                  }
                  required
                />
              </Field>
              <Field
                label={
                  pension
                    ? t("Référence du règlement de pension")
                    : t("Référence du contrat ou du décompte")
                }
                required
                wide
                hint={
                  pension
                    ? t("Reprenez exactement la référence enregistrée avec la caisse de pension.")
                    : t("Assureur ou caisse, numéro de contrat et année : de quoi retrouver le taux.")
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
                <dt>{t("Calcul prévu")}</dt>
                <dd>
                  {pension
                    ? t("Montant mensuel confirmé")
                    : t("Taux × salaire soumis à cotisation")}
                </dd>
                {['aap', 'aanp'].includes(category) && (
                  <>
                    <dt>{t("Plafond accidents 2026")}</dt>
                    <dd>{t("CHF 148’200 par an")}</dd>
                  </>
                )}
              </dl>
              <small>
                {pension
                  ? t("La base légale de pension est contrôlée à partir du salaire annuel confirmé.")
                  : t("Les allocations familiales légales restent exclues du salaire soumis aux cotisations. Confirmez que votre contrat utilise cette base.")}
              </small>
            </div>
            <details className="payroll-simple-guide">
              <summary>{t("Comptes pour la comptabilité")}</summary>
              <p>{t("Choisissez les comptes correspondant à cette cotisation. Ces choix ne modifient pas le net à payer.")}</p>
              <Field label={t("Cotisations à payer")}>
                <PayrollSelect
                  name="liability"
                  defaultValue={
                    editing
                      ? (editing.liabilityAccountId ?? '')
                      : singlePayrollAccount(accounts, 'liability')
                  }
                >
                  <option value="">{t("À compléter avant comptabilisation")}</option>
                  {editing?.liabilityAccountId &&
                    !accounts.some(
                      (a) =>
                        a.id === editing.liabilityAccountId &&
                        a.active &&
                        a.accountType === 'liability',
                    ) && (
                      <option value={editing.liabilityAccountId}>{t("Compte actuel indisponible — à remplacer")}</option>
                    )}
                  {accounts
                    .filter((a) => a.active && a.accountType === 'liability')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                </PayrollSelect>
              </Field>
              <Field label={t("Charges de personnel (part entreprise)")}>
                <PayrollSelect
                  name="expense"
                  defaultValue={
                    editing
                      ? (editing.expenseAccountId ?? '')
                      : singlePayrollAccount(accounts, 'expense')
                  }
                >
                  <option value="">{t("À compléter avant comptabilisation")}</option>
                  {editing?.expenseAccountId &&
                    !accounts.some(
                      (a) =>
                        a.id === editing.expenseAccountId &&
                        a.active &&
                        a.accountType === 'expense',
                    ) && (
                      <option value={editing.expenseAccountId}>{t("Compte actuel indisponible — à remplacer")}</option>
                    )}
                  {accounts
                    .filter((a) => a.active && a.accountType === 'expense')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                </PayrollSelect>
              </Field>
            </details>
            <label className="check-card">
              <input type="checkbox" required />
              <span>{t("J’ai vérifié la part, le montant, les dates et la base sur mon contrat.")}{' '}
                {editing
                  ? t("Les prochaines fiches utiliseront ces réglages ; les fiches déjà comptabilisées restent figées.")
                  : t("Cette cotisation s’ajoute à celles déjà enregistrées.")}
              </span>
            </label>
            <Button
              type="submit"
              disabled={busy || loading || (pension && !employeeId)}
            >
              {editing
                ? t("Enregistrer la modification")
                : t("Enregistrer cette cotisation")}
            </Button>
          </fieldset>
        </form>
        {year !== 2026 && (
          <p>{t("Les réglages guidés couvrent 2026. Pour une autre année, utilisez les paramètres détaillés et le référentiel correspondant.")}</p>
        )}
      </div>
    </section>
  );
}
