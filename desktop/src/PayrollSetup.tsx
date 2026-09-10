import { useEffect, useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { PayrollOrganisationField } from './PayrollOrganisationField';
import { PayrollProblem } from './PayrollProblem';
import { PayrollContractSetup } from './PayrollContractSetup';
import { SWISS_FAMILY_ALLOWANCES_2026 } from './swissFamilyAllowances2026';
import { Button, Field, submitForm } from './ui';
import { centsFromInput, errorMessage } from './utils';
import type { Workspace } from './types';
import type { PayrollHelpTarget } from './payrollHelp';
import './payroll-simple.css';

type Section = 'person' | 'history' | 'insurance' | 'contributions';
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
    sections.some(([id]) => id === initial) ? (initial as Section) : 'person',
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start' });
  }, []);
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
  async function save(form: FormData) {
    if (busy || lock.current) return;
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
          if (section === 'insurance') {
            if (
              !fresh.settings ||
              JSON.stringify(fresh.settings.payroll) !==
                JSON.stringify(settings.payroll)
            )
              throw new Error(
                'Les assurances ont changé pendant votre saisie. Revenez à la fiche puis rouvrez les assurances pour retrouver les dernières informations.',
              );
            const payroll = {
              ...fresh.settings.payroll,
              payrollCanton: canton,
            };
            for (const [field] of funds) payroll[field] = text(field);
            // Naming a fund never enables a module or marks a professional review complete.
            if (text('contractNumber') || text('regulationReference')) {
              payroll.lppPlanEvidence = {
                contractNumber: text('contractNumber'),
                regulationReference: text('regulationReference'),
                effectiveFrom: text('lppFrom'),
                effectiveTo: text('lppTo'),
                employerAggregateShareConfirmed: form.get('lppParity') === 'on',
              };
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
    <div className="payroll-setup">
      <header ref={heading} tabIndex={-1}>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
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
            disabled={busy}
            onClick={() => {
              setSection(id);
              setError('');
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && <PayrollProblem messages={[error]} reveal />}
      {notice && <output>{notice}</output>}
      <form
        hidden={section === 'contributions'}
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
              <p className="payroll-callout">
                Une situation particulière (retraite, contrat court, dispense de
                caisse de pension) se complète dans la fiche collaborateur.
                Aucun choix d’exception n’est fait automatiquement.
              </p>
            </>
          )}
        </fieldset>
        <fieldset
          disabled={busy || section !== 'history'}
          hidden={section !== 'history'}
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
          <details className="payroll-simple-guide">
            <summary>Contrat de la caisse de pension</summary>
            <p>
              Ces informations figurent dans le règlement de prévoyance. Elles
              sont nécessaires avant de valider des cotisations LPP.
            </p>
            <Field label="Numéro du contrat LPP">
              <input
                name="contractNumber"
                defaultValue={settings.payroll.lppPlanEvidence?.contractNumber}
              />
            </Field>
            <Field label="Référence du règlement">
              <input
                name="regulationReference"
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
          </details>
          <small>
            Choisir un nom ne souscrit aucune assurance et ne fixe aucun taux.
            Une modification remet la configuration à contrôler avant de valider
            des fiches.
          </small>
        </fieldset>
        <div className="payroll-setup-actions">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Revenir sans enregistrer
          </Button>
          <Button
            type="submit"
            disabled={busy || (section !== 'insurance' && !employee)}
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
          onSaved={() => {
            onSaved();
            setNotice(
              'Cotisation enregistrée. Revenez au salaire pour choisir les cotisations à appliquer.',
            );
          }}
        />
      </div>
    </div>
  );
}
