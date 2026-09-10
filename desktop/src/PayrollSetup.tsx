import { useEffect, useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { PayrollOrganisationField } from './PayrollOrganisationField';
import { PayrollProblem } from './PayrollProblem';
import { PayrollContractSetup } from './PayrollContractSetup';
import { PayrollContributionsPanel } from './PayrollContributionsPanel';
import {
  payrollDestination,
  revealPayrollField,
  type PayrollSetupSection,
} from './payrollNavigation';
import { pensionPlanComplete, PENSION_GUIDE_SOURCE } from './payrollPension';
import { SWISS_FAMILY_ALLOWANCES_2026 } from './swissFamilyAllowances2026';
import { Button, Field, submitForm } from './ui';
import { centsFromInput, errorMessage } from './utils';
import type { Account, AccountingSettings, Workspace } from './types';
import type { PayrollHelpTarget } from './payrollHelp';
import './payroll-simple.css';

type Section = PayrollSetupSection;
type Runner = (
  action: () => Promise<Workspace>,
  message: string,
  close?: boolean,
  onError?: (reason: unknown) => void,
) => Promise<boolean>;
const sections: [Section, string][] = [
  ['person', 'Le contrat'],
  ['history', 'Début d’année'],
  ['insurance', 'Les assurances'],
  ['contributions', 'Les cotisations'],
];
const funds = [
  ['avsFund', 'avs'],
  ['accidentInsurer', 'accident'],
  ['familyAllowanceFund', 'family'],
  ['dailyAllowanceInsurer', 'daily'],
  ['pensionFund', 'pension'],
] as const;

export function PayrollSetup({
  initial,
  employeeId,
  period,
  workspace,
  busy,
  act,
  onClose,
  onSaved,
}: {
  initial: PayrollHelpTarget;
  employeeId: string;
  period: string;
  workspace: Workspace;
  busy: boolean;
  act: Runner;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [section, setSection] = useState<Section>(
    payrollDestination(initial).section,
  );
  const [destination, setDestination] = useState({
    target: initial,
    revision: 0,
  });
  const container = useRef<HTMLDivElement>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accounting, setAccounting] = useState<AccountingSettings | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(
    initial === 'accounts',
  );
  const [advancedOpened, setAdvancedOpened] = useState(
    initial === 'advanced-contributions',
  );
  const [advancedBusy, setAdvancedBusy] = useState(false);
  const disabled = busy || advancedBusy;
  function navigate(target: PayrollHelpTarget) {
    if (disabled) return;
    if (['review', 'salary', 'period'].includes(target)) {
      onClose();
      return;
    }
    setSection(payrollDestination(target).section);
    setLoadingAccounts(target === 'accounts');
    if (target === 'advanced-contributions') setAdvancedOpened(true);
    setDestination((old) => ({ target, revision: old.revision + 1 }));
  }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (notice) revealPayrollField(container.current, '[data-setup-notice]');
  }, [notice]);
  const lock = useRef(false);
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start' });
  }, []);
  useEffect(() => {
    revealPayrollField(
      container.current,
      payrollDestination(destination.target).selector,
    );
  }, [destination, loadingAccounts]);
  useEffect(() => {
    if (section !== 'accounts') return;
    let active = true;
    void Promise.all([
      desktopApi.listAccounts(),
      desktopApi.getAccountingSettings(),
    ])
      .then(([items, settings]) => {
        if (active) {
          setAccounts(items);
          setAccounting(settings);
        }
      })
      .catch((reason) => {
        if (active)
          setError(
            errorMessage(
              reason,
              'Les comptes sont momentanément indisponibles.',
            ),
          );
      })
      .finally(() => {
        if (active) setLoadingAccounts(false);
      });
    return () => {
      active = false;
    };
  }, [section]);
  // Capture the edited context once; re-read before mutation and reject changed records.
  const [original] = useState(() => structuredClone(workspace));
  const employee = original.employees.find((item) => item.id === employeeId);
  const settings = original.settings!;
  const year = Number(period.slice(0, 4));
  const sameYear = employee?.smallSalaryAssessmentYear === year;
  const [history, setHistory] = useState(
    sameYear &&
      employee?.acOpeningYear === year &&
      employee.laaOpeningYear === year &&
      [
        employee.smallSalaryOpeningGrossCents,
        employee.smallSalaryOpeningContributedBasisCents,
        employee.acOpeningBasisCents,
        employee.laaOpeningBasisCents,
      ].every((value) => value != null)
      ? [
          employee.smallSalaryOpeningGrossCents,
          employee.smallSalaryOpeningContributedBasisCents,
          employee.acOpeningBasisCents,
          employee.laaOpeningBasisCents,
        ].every((value) => value === 0)
        ? 'none'
        : 'previous'
      : '',
  );
  const [canton, setCanton] = useState(settings.payroll.payrollCanton);
  const [exception, setException] = useState(employee?.lppExceptionCode ?? '');
  async function save(form: FormData) {
    if (disabled || loadingAccounts || lock.current) return;
    lock.current = true;
    setError('');
    setNotice('');
    try {
      const text = (name: string) => {
        const value = form.get(name);
        return typeof value === 'string' ? value.trim() : '';
      };
      const data: Record<string, unknown> = {};
      if (section === 'person' && employee) {
        data.birthDate = text('birthDate');
        data.employmentStartDate = text('employmentStartDate');
        data.employmentContractKind = text('employmentContractKind') || null;
        data.employmentEndDate = text('employmentEndDate');
        data.contractualWeeklyMinutes = Math.round(
          Number(text('weeklyHours')) * 60,
        );
        if (
          !data.birthDate ||
          !data.employmentStartDate ||
          !data.contractualWeeklyMinutes
        )
          throw new Error(
            'La date de naissance, le début du contrat et les heures par semaine sont nécessaires.',
          );
        if (data.employmentContractKind === 'fixed' && !data.employmentEndDate)
          throw new Error(
            'Indiquez la date de fin prévue par le contrat à durée déterminée.',
          );
        if (text('lppAnnualSalary')) {
          data.lppAnnualSalaryCents = centsFromInput(
            form.get('lppAnnualSalary'),
          );
          data.lppAssessmentYear = year;
        }
        data.referenceAgeDate = text('referenceAgeDate') || null;
        data.avsAllowanceWaived = text('avsAllowanceWaived')
          ? text('avsAllowanceWaived') === 'yes'
          : null;
        data.lppExceptionCode = exception || null;
        data.lppExceptionEvidenceReference = exception
          ? text('lppExceptionEvidenceReference')
          : null;
        if (exception && !data.lppExceptionEvidenceReference)
          throw new Error(
            'Une exception LPP exige son motif et la référence de sa preuve.',
          );
      } else if (section === 'history' && employee) {
        if (!history)
          throw new Error(
            'Choisissez si des salaires ont été établis avant Zentra cette année.',
          );
        data.smallSalaryAssessmentYear = year;
        data.smallSalarySector = text('sector');
        data.smallSalaryEmployeeRequestedContributions =
          text('requested') === 'yes';
        data.smallSalaryDecisionDate = text('decisionDate');
        data.smallSalaryEvidenceReference = text('evidence');
        data.smallSalaryOpeningGrossCents =
          history === 'none' ? 0 : centsFromInput(form.get('openingGross'));
        data.smallSalaryOpeningContributedBasisCents =
          history === 'none' ? 0 : centsFromInput(form.get('openingAvs'));
        data.acOpeningYear = year;
        data.acOpeningBasisCents =
          history === 'none' ? 0 : centsFromInput(form.get('openingAc'));
        data.laaOpeningYear = year;
        data.laaOpeningBasisCents =
          history === 'none' ? 0 : centsFromInput(form.get('openingLaa'));
        if (
          text('requested') === '' ||
          !data.smallSalarySector ||
          !data.smallSalaryDecisionDate ||
          !data.smallSalaryEvidenceReference
        )
          throw new Error(
            'Complétez la situation du salarié et le document qui confirme les montants de début d’année.',
          );
      }
      const ok = await act(
        async () => {
          const fresh = await desktopApi.loadWorkspace();
          if (section === 'accounts') {
            const [choices, current] = await Promise.all([
              desktopApi.listAccounts(),
              desktopApi.getAccountingSettings(),
            ]);
            if (
              !accounting ||
              JSON.stringify(current) !== JSON.stringify(accounting)
            )
              throw new Error(
                'Les comptes du salaire ont changé. Rouvrez les comptes pour retrouver les dernières informations.',
              );
            const next = { ...current };
            for (const [name, kind] of [
              ['wagesExpenseAccountId', 'expense'],
              ['wagesPayableAccountId', 'liability'],
            ] as const) {
              const selected = choices.find(
                (a) =>
                  a.id === text(name) && a.active && a.accountType === kind,
              );
              if (!selected)
                throw new Error(
                  'Choisissez des comptes de salaire actifs et du bon type.',
                );
              next[name] = selected.id;
            }
            await desktopApi.configureAccounting(next);
            return desktopApi.loadWorkspace();
          }
          if (section === 'insurance') {
            if (
              !fresh.settings ||
              JSON.stringify(fresh.settings.payroll) !==
                JSON.stringify(settings.payroll)
            )
              throw new Error(
                'Les assurances ont changé pendant votre saisie. Revenez à la fiche puis rouvrez les assurances pour retrouver les dernières informations.',
              );
            const payroll = { ...fresh.settings.payroll };
            payroll.payrollCanton = canton;
            for (const [field] of funds) payroll[field] = text(field);
            // Naming a fund never enables a module or marks a professional review complete.
            if (
              text('contractNumber') ||
              text('regulationReference') ||
              text('lppFrom') ||
              text('lppTo') ||
              form.get('lppParity')
            ) {
              payroll.lppPlanEvidence = {
                contractNumber: text('contractNumber'),
                regulationReference: text('regulationReference'),
                effectiveFrom: text('lppFrom'),
                effectiveTo: text('lppTo'),
                employerAggregateShareConfirmed: form.get('lppParity') === 'on',
              };
              if (!pensionPlanComplete(payroll))
                throw new Error(
                  'Contrat de pension incomplet : renseignez la caisse, le numéro, une référence de règlement précise (8 caractères minimum), les dates et la confirmation de la part employeur.',
                );
            }
            if (
              JSON.stringify(payroll) !== JSON.stringify(fresh.settings.payroll)
            )
              payroll.fiduciaryValidated = false;
            return desktopApi.saveSettings({ ...fresh.settings, payroll });
          }
          const current = fresh.employees.find(
            (item) => item.id === employeeId,
          );
          if (
            !employee ||
            !current ||
            JSON.stringify(current) !== JSON.stringify(employee)
          )
            throw new Error(
              'La fiche collaborateur a changé. Revenez au salaire puis rouvrez le contrat pour retrouver les dernières informations.',
            );
          return desktopApi.updateEntity('employees', employeeId, data);
        },
        'Les informations de paie ont été enregistrées.',
        false,
        (reason) =>
          setError(errorMessage(reason, 'L’enregistrement n’a pas abouti.')),
      );
      if (ok) {
        onSaved();
        onClose();
      }
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'Ces informations n’ont pas pu être enregistrées.',
        ),
      );
    } finally {
      lock.current = false;
    }
  }
  return (
    <div className="payroll-setup" ref={container}>
      <header ref={heading} tabIndex={-1}>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={onClose}
        >
          ← Revenir au salaire
        </Button>
        <small>Votre salaire en cours reste conservé.</small>
      </header>
      <nav className="payroll-setup-nav" aria-label="Préparation de la paie">
        {sections.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? 'step' : undefined}
            disabled={disabled}
            onClick={() => {
              navigate(id);
              setError('');
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <PayrollProblem
          messages={[error]}
          reveal
          disabled={disabled}
          onFix={navigate}
        />
      )}
      {notice && (
        <output className="payroll-callout" data-setup-notice>
          <strong>C’est enregistré</strong>
          <span>{notice}</span>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={onClose}
          >
            Revenir à ma fiche de salaire
          </Button>
        </output>
      )}
      <form
        hidden={
          section === 'contributions' || section === 'advanced-contributions'
        }
        onSubmit={(event) => submitForm(save)(event)}
      >
        <fieldset
          disabled={busy || section !== 'person'}
          hidden={section !== 'person'}
        >
          <h3>Le contrat de {employee?.name ?? 'votre collaborateur'}</h3>
          {!employee ? (
            <p>Choisissez d’abord le collaborateur à l’étape précédente.</p>
          ) : (
            <>
              <p>
                Gardez son contrat et sa date de naissance à portée de main.
              </p>
              <div className="form-grid">
                <Field label="Date de naissance" required>
                  <input
                    name="birthDate"
                    type="date"
                    defaultValue={employee.birthDate}
                    required
                  />
                </Field>
                <Field label="Premier jour dans l’entreprise" required>
                  <input
                    name="employmentStartDate"
                    type="date"
                    defaultValue={employee.employmentStart}
                    required
                  />
                </Field>
                <Field
                  label="Heures de travail par semaine"
                  required
                  hint="Horaire contractuel régulier. Pour un horaire variable, utilisez une moyenne représentative confirmée."
                >
                  <input
                    name="weeklyHours"
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    max="168"
                    step="0.01"
                    defaultValue={
                      employee.contractualWeeklyMinutes == null
                        ? ''
                        : employee.contractualWeeklyMinutes / 60
                    }
                    required
                  />
                </Field>
                <Field label="Type de contrat" required>
                  <select
                    name="employmentContractKind"
                    defaultValue={employee.employmentContractKind ?? ''}
                    required
                  >
                    <option value="">Choisir</option>
                    <option value="indefinite">Sans date de fin (CDI)</option>
                    <option value="fixed">Avec une date de fin (CDD)</option>
                  </select>
                </Field>
                <Field
                  label="Dernier jour prévu"
                  hint="À remplir pour un contrat avec une date de fin."
                >
                  <input
                    name="employmentEndDate"
                    type="date"
                    defaultValue={employee.employmentEnd}
                  />
                </Field>
                <Field
                  label={`Salaire annuel annoncé à la caisse de pension · ${year}`}
                  hint="Montant brut annuel confirmé pour ce contrat. Laissez vide si vous devez encore le demander."
                >
                  <input
                    name="lppAnnualSalary"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    defaultValue={
                      employee.lppAssessmentYear === year &&
                      employee.lppAnnualSalaryCents != null
                        ? employee.lppAnnualSalaryCents / 100
                        : ''
                    }
                    placeholder="CHF par année"
                  />
                </Field>
              </div>
              <details className="payroll-simple-guide" data-payroll-situation>
                <summary>Retraite ou exception de caisse de pension</summary>
                <p>
                  À compléter uniquement si cela concerne cette personne,
                  d’après les documents de sa caisse.
                </p>
                <Field
                  label="Date de référence pour la retraite"
                  hint="Demandez la date applicable à la caisse AVS si vous ne la connaissez pas."
                >
                  <input
                    name="referenceAgeDate"
                    type="date"
                    defaultValue={employee.referenceAgeDate}
                  />
                </Field>
                <Field label="Franchise AVS après l’âge de référence">
                  <select
                    name="avsAllowanceWaived"
                    defaultValue={
                      employee.avsAllowanceWaived == null
                        ? ''
                        : employee.avsAllowanceWaived
                          ? 'yes'
                          : 'no'
                    }
                  >
                    <option value="">À confirmer / pas concerné</option>
                    <option value="no">Le salarié conserve la franchise</option>
                    <option value="yes">
                      Le salarié renonce à la franchise
                    </option>
                  </select>
                </Field>
                <Field label="Exception de pension confirmée">
                  <select
                    name="lppExceptionCode"
                    value={exception}
                    onChange={(event) =>
                      setException(event.target.value as typeof exception)
                    }
                  >
                    <option value="">Aucune exception</option>
                    <option value="short_fixed_contract">
                      Contrat à durée déterminée de trois mois au maximum
                    </option>
                    <option value="other_legal">
                      Autre exception légale confirmée
                    </option>
                  </select>
                </Field>
                {exception && (
                  <Field
                    label="Document qui confirme l’exception"
                    required
                    hint="Référence du contrat signé ou de la décision écrite de la caisse."
                  >
                    <input
                      name="lppExceptionEvidenceReference"
                      required
                      maxLength={500}
                      defaultValue={
                        employee.lppExceptionEvidenceReference ?? ''
                      }
                    />
                  </Field>
                )}
              </details>
            </>
          )}
        </fieldset>
        <fieldset
          disabled={busy || section !== 'history'}
          hidden={section !== 'history'}
          data-payroll-history
        >
          <h3>Avant la première fiche dans Zentra</h3>
          <p>
            Pour {employee?.name}, en {year}. Reprenez les fiches établies avant
            ce mois qui ne sont pas dans Zentra.
          </p>
          <details className="payroll-simple-guide">
            <summary>Quels montants faut-il reprendre ?</summary>
            <p>
              Comptez uniquement les salaires de votre entreprise, même s’ils ne
              sont pas encore payés. Les fiches déjà dans Zentra sont ajoutées
              automatiquement : ne les recopiez pas ici.
            </p>
          </details>
          <Field label="Y a-t-il des salaires à reprendre ?" required>
            <select
              value={history}
              onChange={(event) => setHistory(event.target.value)}
              required
            >
              <option value="">Je dois encore vérifier</option>
              <option value="none">
                Non, aucun salaire avant Zentra cette année
              </option>
              <option value="previous">
                Oui, des fiches ont été faites dans un autre système
              </option>
            </select>
          </Field>
          {history === 'none' && (
            <p className="payroll-callout">
              Les quatre montants de départ seront enregistrés à CHF 0. Les
              salaires déjà saisis dans Zentra restent conservés.
            </p>
          )}
          <div className="form-grid" hidden={history !== 'previous'}>
            {[
              [
                'openingGross',
                'Total brut des fiches précédentes',
                employee?.smallSalaryOpeningGrossCents,
                sameYear,
              ],
              [
                'openingAvs',
                'Salaire déjà soumis à l’AVS',
                employee?.smallSalaryOpeningContributedBasisCents,
                sameYear,
              ],
              [
                'openingAc',
                'Salaire déjà soumis au chômage',
                employee?.acOpeningBasisCents,
                employee?.acOpeningYear === year,
              ],
              [
                'openingLaa',
                'Salaire déjà soumis aux accidents',
                employee?.laaOpeningBasisCents,
                employee?.laaOpeningYear === year,
              ],
            ].map(([name, label, amount, current]) => (
              <Field
                key={String(name)}
                label={String(label)}
                required
                hint="Recopiez le cumul de salaire du dernier décompte, pas le montant des cotisations retenues."
              >
                <input
                  name={String(name)}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  disabled={history !== 'previous'}
                  required={history === 'previous'}
                  defaultValue={
                    current && typeof amount === 'number' ? amount / 100 : ''
                  }
                  placeholder="CHF"
                />
              </Field>
            ))}
          </div>
          <Field
            label="Dans quel cadre cette personne travaille-t-elle ?"
            required
          >
            <select
              name="sector"
              defaultValue={employee?.smallSalarySector ?? ''}
              required
            >
              <option value="">Choisir le cadre de travail</option>
              <option value="ordinary">Entreprise : activité habituelle</option>
              <option value="private_household">
                Ménage privé : emploi à domicile
              </option>
              <option value="arts_culture">
                Activité dans les arts ou la culture
              </option>
            </select>
          </Field>
          <Field
            label="Le salarié a-t-il demandé de cotiser même pour un petit salaire ?"
            required
            hint="Cette question concerne la dispense éventuelle pour les faibles salaires annuels. Au-dessus du seuil applicable, les cotisations restent dues."
          >
            <select
              name="requested"
              defaultValue={
                sameYear &&
                employee?.smallSalaryEmployeeRequestedContributions != null
                  ? employee.smallSalaryEmployeeRequestedContributions
                    ? 'yes'
                    : 'no'
                  : ''
              }
              required
            >
              <option value="">À confirmer avec le salarié</option>
              <option value="no">Non, aucune demande particulière</option>
              <option value="yes">Oui, il a demandé à cotiser</option>
            </select>
          </Field>
          <Field label="Date de confirmation" required>
            <input
              name="decisionDate"
              type="date"
              min={`${year}-01-01`}
              max={`${year}-12-31`}
              defaultValue={sameYear ? employee?.smallSalaryDecisionDate : ''}
              required
            />
          </Field>
          <Field
            label="Document ou confirmation utilisée"
            required
            hint="Par exemple : décompte août 2026, ou confirmation du début d’activité. Conservez ce document."
          >
            <input
              name="evidence"
              maxLength={500}
              defaultValue={
                sameYear ? employee?.smallSalaryEvidenceReference : ''
              }
              required
            />
          </Field>
        </fieldset>
        <fieldset
          disabled={busy || section !== 'insurance'}
          hidden={section !== 'insurance'}
        >
          <h3>Les assurances de l’entreprise</h3>
          <p>
            Recopiez les noms de vos contrats ou recherchez votre caisse dans la
            liste.
          </p>
          <Field label="Canton de paie" required>
            <select
              value={canton}
              onChange={(event) => setCanton(event.target.value)}
              required
            >
              <option value="">Choisir un canton</option>
              {SWISS_FAMILY_ALLOWANCES_2026.map((item) => (
                <option key={item.canton} value={item.canton}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          {funds.map(([field, kind]) => (
            <PayrollOrganisationField
              key={field}
              kind={kind}
              name={field}
              defaultValue={settings.payroll[field]}
              canton={canton}
              disabled={busy}
            />
          ))}
          <details className="payroll-simple-guide" data-pension-plan>
            <summary>Contrat de la caisse de pension</summary>
            <p>
              Ces informations figurent dans le règlement de prévoyance. Elles
              sont nécessaires avant de valider des cotisations LPP.
            </p>
            <ol>
              <li>Indiquez le nom de la caisse ci-dessus.</li>
              <li>
                Recopiez le numéro, la référence et la validité du contrat
                ci-dessous.
              </li>
              <li>
                Dans les cotisations, indiquez les montants mensuels de chaque
                personne.
              </li>
            </ol>
            <Field label="Numéro du contrat LPP">
              <input
                name="contractNumber"
                defaultValue={settings.payroll.lppPlanEvidence?.contractNumber}
              />
            </Field>
            <Field label="Référence du règlement">
              <input
                name="regulationReference"
                minLength={8}
                maxLength={500}
                defaultValue={
                  settings.payroll.lppPlanEvidence?.regulationReference
                }
              />
            </Field>
            <div className="form-grid">
              <Field label="Valable dès le">
                <input
                  name="lppFrom"
                  type="date"
                  defaultValue={settings.payroll.lppPlanEvidence?.effectiveFrom}
                />
              </Field>
              <Field
                label="Fin de la période confirmée"
                hint="Date de fin de validité des informations reçues de la caisse."
              >
                <input
                  name="lppTo"
                  type="date"
                  defaultValue={settings.payroll.lppPlanEvidence?.effectiveTo}
                />
              </Field>
            </div>
            <label className="check-card">
              <input
                name="lppParity"
                type="checkbox"
                defaultChecked={
                  settings.payroll.lppPlanEvidence
                    ?.employerAggregateShareConfirmed
                }
              />
              <span>
                Le règlement confirme que l’employeur finance au moins la moitié
                des cotisations de l’ensemble du personnel assuré.
              </span>
            </label>
            <details>
              <summary>Je ne trouve pas ces informations</summary>
              <p>
                Demandez à votre caisse le contrat d’affiliation, le règlement
                en vigueur et le certificat de prévoyance de votre
                collaborateur. Demandez les montants mensuels à prélever et la
                part à payer par l’entreprise. Vous pouvez revenir au salaire et
                conserver une fiche à compléter.
              </p>
              <a href={PENSION_GUIDE_SOURCE} target="_blank" rel="noreferrer">
                Comprendre les cotisations de pension — OFAS
              </a>
            </details>
          </details>
          <small>
            Choisir un nom ne souscrit aucune assurance et ne fixe aucun taux.
            Une modification remet la configuration à contrôler avant de valider
            des fiches.
          </small>
        </fieldset>
        <fieldset
          disabled={disabled || loadingAccounts || section !== 'accounts'}
          hidden={section !== 'accounts'}
        >
          <h3>Les comptes du salaire</h3>
          <p>
            Choisissez les comptes actifs du plan comptable de l’entreprise. Le
            montant à verser au salarié reste le même.
          </p>
          {loadingAccounts && <p>Chargement des comptes…</p>}
          {(['wagesExpenseAccountId', 'wagesPayableAccountId'] as const).map(
            (name) => {
              const kind =
                name === 'wagesExpenseAccountId' ? 'expense' : 'liability';
              const available = accounts.filter(
                (a) => a.active && a.accountType === kind,
              );
              return (
                <Field
                  key={`${name}-${accounting?.[name]}`}
                  label={
                    kind === 'expense'
                      ? 'Charges de personnel'
                      : 'Salaires à payer'
                  }
                  required
                >
                  <select
                    name={name}
                    defaultValue={accounting?.[name] ?? ''}
                    required
                  >
                    <option value="">Choisir un compte actif</option>
                    {accounting?.[name] &&
                      !available.some((a) => a.id === accounting[name]) && (
                        <option value={accounting[name]} disabled>
                          Compte actuel indisponible — choisissez un autre
                          compte
                        </option>
                      )}
                    {available.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              );
            },
          )}
        </fieldset>
        <div className="payroll-setup-actions">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={disabled}
          >
            Revenir sans enregistrer
          </Button>
          <Button
            type="submit"
            disabled={
              disabled ||
              loadingAccounts ||
              (!['insurance', 'accounts'].includes(section) && !employee)
            }
          >
            {busy ? 'Enregistrement…' : 'Enregistrer et revenir au salaire'}
          </Button>
        </div>
      </form>
      <div hidden={section !== 'contributions'}>
        <PayrollContractSetup
          workspace={workspace}
          employeeId={employeeId}
          period={period}
          busy={busy}
          act={act}
          destination={destination}
          onFix={navigate}
          onSaved={() => {
            onSaved();
            setNotice(
              'Cotisation enregistrée. Revenez au salaire pour choisir les cotisations à appliquer.',
            );
          }}
        />
      </div>
      <div hidden={section !== 'advanced-contributions'}>
        {advancedOpened && (
          <PayrollContributionsPanel
            onChanged={onSaved}
            onBusyChange={setAdvancedBusy}
            onFix={navigate}
          />
        )}
      </div>
    </div>
  );
}
