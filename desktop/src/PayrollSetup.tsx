import { t, useAppLanguage, type InterfaceMessage } from './language';
import { PayrollSelect } from './PayrollSelect';
import { useEffect, useRef, useState } from 'react';
import { desktopApi } from './bridge';
import { PayrollOrganisationField } from './PayrollOrganisationField';
import { PayrollProblem } from './PayrollProblem';
import { usePayrollFieldGuide } from './PayrollFieldGuide';
import {
  parseSmallSalaryEmployeeForm,
  SmallSalaryFormError,
} from './smallSalaryAssessment';
import { PayrollContractSetup } from './PayrollContractSetup';
import { PayrollContributionsPanel } from './PayrollContributionsPanel';
import {
  payrollDestination,
  revealPayrollField,
  type PayrollSetupSection,
} from './payrollNavigation';
import { pensionPlanIssue, PENSION_GUIDE_SOURCE } from './payrollPension';
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
  initialSelector,
  employeeId,
  period,
  contributionDate,
  workspace,
  busy,
  act,
  onClose,
  onSaved,
  guided = false,
  returnToPreparation = false,
}: {
  initial: PayrollHelpTarget;
  initialSelector?: string;
  employeeId: string;
  period: string;
  contributionDate?: string;
  workspace: Workspace;
  busy: boolean;
  act: Runner;
  onClose: () => void;
  onSaved: () => void;
  guided?: boolean;
  returnToPreparation?: boolean;
}) {
  useAppLanguage();
  const [section, setSection] = useState<Section>(
    payrollDestination(initial).section,
  );
  const [destination, setDestination] = useState({
    target: initial,
    selector: initialSelector,
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
  function navigate(target: PayrollHelpTarget, selector?: string) {
    if (disabled) return;
    fieldGuide.clear();
    if (['review', 'salary', 'period'].includes(target)) {
      onClose();
      return;
    }
    setSection(payrollDestination(target).section);
    setLoadingAccounts(target === 'accounts');
    if (target === 'advanced-contributions') setAdvancedOpened(true);
    setDestination((old) => ({ target, selector, revision: old.revision + 1 }));
  }
  const [error, setError] = useState('');
  const fieldGuide = usePayrollFieldGuide();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (notice) revealPayrollField(container.current, '[data-setup-notice]');
  }, [notice]);
  const lock = useRef(false);
  function rejectField(name: string, message: string, presentation?: InterfaceMessage) {
    const field = container.current?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
    if (!field) return;
    const questionId = field.closest<HTMLElement>('[data-payroll-question]')?.dataset.payrollQuestion;
    const index = Number(questionId?.match(/-(\d+)/)?.[1] ?? 0);
    if (guided) setQuestion(Math.min(index, questionCount - 1));
    fieldGuide.reject(field, message, presentation);
  }
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start' });
  }, []);
  useEffect(() => {
    revealPayrollField(
      container.current,
      destination.selector ?? payrollDestination(destination.target).selector,
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
  const pensionOnly = guided && destination.target === 'pension-person';
  const pensionPlanOnly = guided && destination.target === 'pension-plan';
  const [question, setQuestion] = useState(0);
  const questionCount =
    section === 'person'
      ? pensionOnly
        ? 1
        : 3
      : section === 'history'
        ? 3
        : section === 'insurance' && !pensionPlanOnly
          ? 2
          : 1;
  useEffect(() => {
    const target = container.current?.querySelector(
      destination.selector ?? payrollDestination(destination.target).selector,
    );
    const name =
      target?.closest<HTMLElement>('[data-payroll-question]')?.dataset
        .payrollQuestion ?? '';
    const index = Number(name.match(/-(\d+)/)?.[1] ?? 0);
    setQuestion(Math.min(index, questionCount - 1));
  }, [destination, questionCount]);
  useEffect(() => {
    if (!guided) return;
    const area = container.current?.querySelector<HTMLElement>(
      `[data-payroll-question="${section}-${question}"]`,
    );
    const focus =
      area?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      area?.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), summary',
      );
    focus?.focus({ preventScroll: true });
    area?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [question, section, guided]);
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
      if (section === 'insurance') {
        const hasPlan = pensionPlanOnly || ['contractNumber', 'regulationReference', 'lppFrom', 'lppTo'].some(name => text(name)) || form.get('lppParity');
        if (hasPlan) {
          const plan = { contractNumber: text('contractNumber'), regulationReference: text('regulationReference'),
            effectiveFrom: text('lppFrom'), effectiveTo: text('lppTo'), employerAggregateShareConfirmed: form.get('lppParity') === 'on' };
          const checkDate = pensionPlanOnly || JSON.stringify(plan) !== JSON.stringify(settings.payroll.lppPlanEvidence);
          const issue = pensionPlanIssue({
            ...settings.payroll, pensionFund: text('pensionFund'),
            lppPlanEvidence: plan,
          }, checkDate ? contributionDate ?? `${period}-01` : undefined);
          if (issue) { rejectField(issue.field, issue.message, issue.presentation); return; }
        }
      }
      if (section === 'person' && employee && pensionOnly) {
        data.lppAnnualSalaryCents = centsFromInput(form.get('lppAnnualSalary'));
        data.lppAssessmentYear = year;
      } else if (section === 'person' && employee) {
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
        Object.assign(
          data,
          parseSmallSalaryEmployeeForm({
            assessmentYear: String(year),
            sector: text('sector'),
            employeeRequestedContributions: text('requested'),
            decisionDate: text('decisionDate'),
            evidenceReference: text('evidence'),
            openingGross: history === 'none' ? '0' : text('openingGross'),
            openingContributedBasis:
              history === 'none' ? '0' : text('openingAvs'),
          }),
        );
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
            if (!pensionPlanOnly) payroll.payrollCanton = canton;
            for (const [field] of funds)
              if (!pensionPlanOnly || field === 'pensionFund')
                payroll[field] = text(field);
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
      if (reason instanceof SmallSalaryFormError) {
        const names: Record<string, string> = {
          smallSalarySector: 'sector',
          smallSalaryEmployeeRequestedContributions: 'requested',
          smallSalaryDecisionDate: 'decisionDate',
          smallSalaryEvidenceReference: 'evidence',
          smallSalaryOpeningGross: 'openingGross',
          smallSalaryOpeningContributedBasis: 'openingAvs',
        };
        if (names[reason.field]) {
          rejectField(names[reason.field], reason.message, reason.presentation);
          return;
        }
      }
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
    <div
      className={`payroll-setup${guided ? ' payroll-setup--guided' : ''}`}
      ref={container}
    >
      <header ref={heading} tabIndex={-1}>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={onClose}
        >
          {returnToPreparation ? t("← Revenir à ma préparation") : t("← Revenir au salaire")}
        </Button>
        <small>{t("Votre salaire reste conservé. Les nouvelles cotisations applicables seront reprises après l’enregistrement.")}</small>
      </header>
      <nav
        className="payroll-setup-nav"
        aria-label={t("Préparation de la paie")}
        hidden={guided}
      >
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
            {t(label)}
          </button>
        ))}
      </nav>
      {guided && questionCount > 1 && (
        <p className="payroll-question-progress" role="status">
          {section === 'person'
            ? t("Son contrat de travail")
            : section === 'history'
              ? t("Les informations de début d’année")
              : t("Vos assurances")}{' '}
          · {t("Étape {index} sur {count}", { index: question + 1, count: questionCount })}
        </p>
      )}
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
          <strong>{t("C’est enregistré")}</strong>
          <span>{t(notice)}</span>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={onClose}
          >{t("Revenir à ma fiche de salaire")}</Button>
        </output>
      )}
      <form
        noValidate
        hidden={
          section === 'contributions' || section === 'advanced-contributions'
        }
        onSubmit={(event) => {
          if (guided && question < questionCount - 1) {
            event.preventDefault();
            const area = event.currentTarget.querySelector<HTMLElement>(
              `[data-payroll-question="${section}-${question}"]`,
            );
            if (!area || fieldGuide.check(area))
              setQuestion((value) => value + 1);
            return;
          }
          const invalid = fieldGuide.firstInvalid(event.currentTarget);
          if (guided && invalid) {
            const name =
              invalid.closest<HTMLElement>('[data-payroll-question]')?.dataset
                .payrollQuestion ?? '';
            const index = name.match(/-(\d+)/)?.[1];
            if (index) setQuestion(Math.min(Number(index), questionCount - 1));
          }
          if (!fieldGuide.check(event.currentTarget)) {
            event.preventDefault();
            return;
          }
          return submitForm(save)(event);
        }}
      >
        {fieldGuide.guide}
        <fieldset
          disabled={busy || section !== 'person'}
          hidden={section !== 'person'}
        >
          <h3>
            {pensionOnly
              ? t("Quel salaire annuel avez-vous annoncé à la caisse ?")
              : t("Le contrat de {v0}", { v0: employee?.name ?? t('votre collaborateur') })}
          </h3>
          {!employee ? (
            <p>{t("Choisissez d’abord le collaborateur à l’étape précédente.")}</p>
          ) : (
            <>
              <p hidden={pensionOnly}>{t("Gardez son contrat et sa date de naissance à portée de main.")}</p>
              <fieldset disabled={pensionOnly} hidden={pensionOnly}>
                <div
                  className="form-grid"
                  data-payroll-question="person-0"
                  hidden={guided && question !== 0}
                >
                  <Field label={t("Date de naissance")} required>
                    <input
                      name="birthDate"
                      type="date"
                      defaultValue={employee.birthDate}
                      required
                    />
                  </Field>
                </div>
                <div
                  className="form-grid"
                  data-payroll-question="person-1"
                  hidden={guided && question !== 1}
                >
                  <Field label={t("Premier jour dans l’entreprise")} required>
                    <input
                      name="employmentStartDate"
                      type="date"
                      defaultValue={employee.employmentStart}
                      required
                    />
                  </Field>
                  <Field
                    label={t("Heures de travail par semaine")}
                    required
                    hint={t("Horaire contractuel régulier. Pour un horaire variable, utilisez une moyenne représentative confirmée.")}
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
                  <Field label={t("Type de contrat")} required>
                    <PayrollSelect
                      name="employmentContractKind"
                      defaultValue={employee.employmentContractKind ?? ''}
                      required
                    >
                      <option value="">{t("Choisir")}</option>
                      <option value="indefinite">{t("Sans date de fin (CDI)")}</option>
                      <option value="fixed">{t("Avec une date de fin (CDD)")}</option>
                    </PayrollSelect>
                  </Field>
                  <Field
                    label={t("Dernier jour prévu")}
                    hint={t("À remplir pour un contrat avec une date de fin.")}
                  >
                    <input
                      name="employmentEndDate"
                      type="date"
                      defaultValue={employee.employmentEnd}
                    />
                  </Field>
                </div>
              </fieldset>
              <div
                data-payroll-question={pensionOnly ? 'person-0' : 'person-2'}
                hidden={guided && !pensionOnly && question !== 2}
              >
                <Field
                  label={t("Salaire annuel annoncé à la caisse de pension · {v0}", { v0: year })}
                  required={pensionOnly}
                  hint={t("Montant brut annuel confirmé pour ce contrat. Laissez vide si vous devez encore le demander.")}
                >
                  <input
                    name="lppAnnualSalary"
                    required={pensionOnly}
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
                    placeholder={t("CHF par année")}
                  />
                </Field>
              </div>
              <fieldset
                data-payroll-question="person-2-situation"
                disabled={pensionOnly}
                hidden={pensionOnly || (guided && question !== 2)}
              >
                <details
                  className="payroll-simple-guide"
                  data-payroll-situation
                >
                  <summary>{t("Retraite ou exception de caisse de pension")}</summary>
                  <p>{t("À compléter uniquement si cela concerne cette personne, d’après les documents de sa caisse.")}</p>
                  <Field
                    label={t("Date de référence pour la retraite")}
                    hint={t("Demandez la date applicable à la caisse AVS si vous ne la connaissez pas.")}
                  >
                    <input
                      name="referenceAgeDate"
                      type="date"
                      defaultValue={employee.referenceAgeDate}
                    />
                  </Field>
                  <Field label={t("Franchise AVS après l’âge de référence")}>
                    <PayrollSelect
                      name="avsAllowanceWaived"
                      defaultValue={
                        employee.avsAllowanceWaived == null
                          ? ''
                          : employee.avsAllowanceWaived
                            ? 'yes'
                            : 'no'
                      }
                    >
                      <option value="">{t("À confirmer / pas concerné")}</option>
                      <option value="no">{t("Le salarié conserve la franchise")}</option>
                      <option value="yes">{t("Le salarié renonce à la franchise")}</option>
                    </PayrollSelect>
                  </Field>
                  <Field label={t("Exception de pension confirmée")}>
                    <PayrollSelect
                      name="lppExceptionCode"
                      value={exception}
                      onChange={(event) =>
                        setException(event.target.value as typeof exception)
                      }
                    >
                      <option value="">{t("Aucune exception")}</option>
                      <option value="short_fixed_contract">{t("Contrat à durée déterminée de trois mois au maximum")}</option>
                      <option value="other_legal">{t("Autre exception légale confirmée")}</option>
                    </PayrollSelect>
                  </Field>
                  {exception && (
                    <Field
                      label={t("Document qui confirme l’exception")}
                      required
                      hint={t("Référence du contrat signé ou de la décision écrite de la caisse.")}
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
              </fieldset>
            </>
          )}
        </fieldset>
        <fieldset
          disabled={busy || section !== 'history'}
          hidden={section !== 'history'}
          data-payroll-history
        >
          <h3>{!guided || question === 0 ? t("Les salaires déjà établis cette année") : question === 1 ? t("La situation de votre collaborateur") : t("La confirmation de ces informations")}</h3>
          <p>{t("Pour {name}, en {year}. Reprenez les fiches établies avant ce mois qui ne sont pas dans Zentra.", { name: employee?.name ?? t('votre collaborateur'), year })}</p>
          <div
            data-payroll-question="history-0"
            hidden={guided && question !== 0}
          >
            <details className="payroll-simple-guide">
              <summary>{t("Quels montants faut-il reprendre ?")}</summary>
              <p>{t("Comptez uniquement les salaires de votre entreprise, même s’ils ne sont pas encore payés. Les fiches déjà dans Zentra sont ajoutées automatiquement : ne les recopiez pas ici.")}</p>
            </details>
            <Field label={t("Y a-t-il des salaires à reprendre ?")} required>
              <PayrollSelect
                value={history}
                onChange={(event) => setHistory(event.target.value)}
                required
              >
                <option value="">{t("Je dois encore vérifier")}</option>
                <option value="none">{t("Non, aucun salaire avant Zentra cette année")}</option>
                <option value="previous">{t("Oui, des fiches ont été faites dans un autre système")}</option>
              </PayrollSelect>
            </Field>
            {history === 'none' && (
              <p className="payroll-callout">{t("Les quatre montants de départ seront enregistrés à CHF 0. Les salaires déjà saisis dans Zentra restent conservés.")}</p>
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
                  label={t(String(label))}
                  required
                  hint={t("Recopiez le cumul de salaire du dernier décompte, pas le montant des cotisations retenues.")}
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
          </div>
          <div
            data-payroll-question="history-1"
            hidden={guided && question !== 1}
          >
            <Field
              label={t("Dans quel cadre cette personne travaille-t-elle ?")}
              required
            >
              <PayrollSelect
                name="sector"
                defaultValue={employee?.smallSalarySector ?? ''}
                required
              >
                <option value="">{t("Choisir le cadre de travail")}</option>
                <option value="ordinary">{t("Entreprise : activité habituelle")}</option>
                <option value="private_household">{t("Ménage privé : emploi à domicile")}</option>
                <option value="arts_culture">{t("Activité dans les arts ou la culture")}</option>
              </PayrollSelect>
            </Field>
            <Field
              label={t("Le salarié a-t-il demandé de cotiser même pour un petit salaire ?")}
              required
              hint={t("Cette question concerne la dispense éventuelle pour les faibles salaires annuels. Au-dessus du seuil applicable, les cotisations restent dues.")}
            >
              <PayrollSelect
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
                <option value="">{t("À confirmer avec le salarié")}</option>
                <option value="no">{t("Non, aucune demande particulière")}</option>
                <option value="yes">{t("Oui, il a demandé à cotiser")}</option>
              </PayrollSelect>
            </Field>
          </div>
          <div
            data-payroll-question="history-2"
            hidden={guided && question !== 2}
          >
            <p className="payroll-question-explanation">{t("Ces deux champs servent à retrouver le choix confirmé avec le salarié et les montants de départ. Recopiez la date et le nom de votre document ; ce n’est pas la date de création de la fiche.")}</p>
            <Field
              label={t("Date du choix de cotisation · {v0}", { v0: year })}
              required
              hint={t("Indiquez quand le choix ci-dessus a été confirmé. La date figure sur votre déclaration ou confirmation écrite de {v0}. Si vous ne la connaissez pas, demandez-la au salarié ou à votre caisse AVS.", { v0: year })}
            >
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
              label={t("Nom du document ou de la confirmation")}
              required
              hint={t("Par exemple : décompte août 2026, ou confirmation du début d’activité. Conservez ce document.")}
            >
              <input
                name="evidence"
                maxLength={500}
                defaultValue={
                  sameYear ? employee?.smallSalaryEvidenceReference : ''
                }
                required
                placeholder={t("Ex. : confirmation du début d’activité {v0}", { v0: year })}
              />
            </Field>
          </div>
        </fieldset>
        <fieldset
          disabled={busy || section !== 'insurance'}
          hidden={section !== 'insurance'}
        >
          <h3>
            {pensionPlanOnly
              ? t("Le contrat de votre caisse de pension")
              : t("Les assurances de l’entreprise")}
          </h3>
          <p>{t("Recopiez les noms de vos contrats ou recherchez votre caisse dans la liste.")}</p>
          <div
            data-payroll-question="insurance-0"
            hidden={guided && !pensionPlanOnly && question !== 0}
          >
            {!pensionPlanOnly && (
              <Field label={t("Canton de paie")} required>
                <PayrollSelect
                  value={canton}
                  onChange={(event) => setCanton(event.target.value)}
                  required
                >
                  <option value="">{t("Choisir un canton")}</option>
                  {SWISS_FAMILY_ALLOWANCES_2026.map((item) => (
                    <option key={item.canton} value={item.canton}>
                      {t(item.name)}
                    </option>
                  ))}
                </PayrollSelect>
              </Field>
            )}
            {funds
              .filter(([field]) => !pensionPlanOnly || field === 'pensionFund')
              .map(([field, kind]) => (
                <PayrollOrganisationField
                  key={field}
                  kind={kind}
                  name={field}
                  defaultValue={settings.payroll[field]}
                  canton={canton}
                  disabled={busy}
                />
              ))}
          </div>
          <div
            data-payroll-question={
              pensionPlanOnly ? 'insurance-0-plan' : 'insurance-1'
            }
            hidden={guided && !pensionPlanOnly && question !== 1}
          >
            <details
              className="payroll-simple-guide"
              data-pension-plan
              open={
                pensionPlanOnly || (guided && question === 1) ? true : undefined
              }
            >
              <summary>{t("Contrat de la caisse de pension")}</summary>
              <p>{t("Ces informations figurent dans le règlement de prévoyance. Elles sont nécessaires avant de valider des cotisations LPP.")}</p>
              <ol>
                <li>{t("Indiquez le nom de la caisse ci-dessus.")}</li>
                <li>{t("Recopiez le numéro, la référence et la validité du contrat ci-dessous.")}</li>
                <li>{t("Dans les cotisations, indiquez les montants mensuels de chaque personne.")}</li>
              </ol>
              <Field label={t("Numéro du contrat LPP")} hint={t("Le numéro d’affiliation de votre entreprise auprès de cette caisse.")}>
                <input
                  name="contractNumber"
                  defaultValue={
                    settings.payroll.lppPlanEvidence?.contractNumber
                  }
                />
              </Field>
              <Field label={t("Référence du règlement")} hint={t("Le titre et l’année ou la version du règlement reçu de la caisse.")}>
                <input
                  name="regulationReference"
                  maxLength={500}
                  placeholder={t("Ex. : règlement de prévoyance 2026")}
                  defaultValue={
                    settings.payroll.lppPlanEvidence?.regulationReference
                  }
                />
              </Field>
              <div className="form-grid">
              <Field label={t("Valable dès le")} hint={t("La date de début indiquée dans les documents de la caisse.")}>
                  <input
                    name="lppFrom"
                    type="date"
                    defaultValue={
                      settings.payroll.lppPlanEvidence?.effectiveFrom
                    }
                  />
                </Field>
                <Field
                  label={t("Fin de la période confirmée")}
                  hint={t("Date de fin de validité des informations reçues de la caisse.")}
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
                  aria-label={t("Part de l’entreprise confirmée dans le règlement")}
                  type="checkbox"
                  defaultChecked={
                    settings.payroll.lppPlanEvidence
                      ?.employerAggregateShareConfirmed
                  }
                />
                <span>{t("Le règlement confirme que l’employeur finance au moins la moitié des cotisations de l’ensemble du personnel assuré.")}</span>
              </label>
              <details>
                <summary>{t("Je ne trouve pas ces informations")}</summary>
                <p>{t("Demandez à votre caisse le contrat d’affiliation, le règlement en vigueur et le certificat de prévoyance de votre collaborateur. Demandez les montants mensuels à prélever et la part à payer par l’entreprise. Vous pouvez revenir au salaire et conserver une fiche à compléter.")}</p>
                <a href={PENSION_GUIDE_SOURCE} target="_blank" rel="noreferrer">{t("Comprendre les cotisations de pension — OFAS")}</a>
              </details>
            </details>
          </div>
          <small>{t("Choisir un nom ne souscrit aucune assurance et ne fixe aucun taux. Une modification remet la configuration à contrôler avant de valider des fiches.")}</small>
        </fieldset>
        <fieldset
          disabled={disabled || loadingAccounts || section !== 'accounts'}
          hidden={section !== 'accounts'}
        >
          <h3>{t("Les comptes du salaire")}</h3>
          <p>{t("Choisissez les comptes actifs du plan comptable de l’entreprise. Le montant à verser au salarié reste le même.")}</p>
          {loadingAccounts && <p>{t("Chargement des comptes…")}</p>}
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
                      ? t("Charges de personnel")
                      : t("Salaires à payer")
                  }
                  required
                >
                  <PayrollSelect
                    name={name}
                    defaultValue={accounting?.[name] ?? ''}
                    required
                  >
                    <option value="">{t("Choisir un compte actif")}</option>
                    {accounting?.[name] &&
                      !available.some((a) => a.id === accounting[name]) && (
                        <option value={accounting[name]} disabled>{t("Compte actuel indisponible — choisissez un autre compte")}</option>
                      )}
                    {available.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </PayrollSelect>
                </Field>
              );
            },
          )}
        </fieldset>
        <div className="payroll-setup-actions">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (guided && question > 0) {
                fieldGuide.clear();
                setQuestion((value) => value - 1);
              } else onClose();
            }}
            disabled={disabled}
          >
            {guided && question > 0
              ? t("Étape précédente")
              : t("Revenir sans enregistrer")}
          </Button>
          <Button
            type="submit"
            disabled={
              disabled ||
              loadingAccounts ||
              (!['insurance', 'accounts'].includes(section) && !employee)
            }
          >
            {busy
              ? t("Enregistrement…")
              : guided && question < questionCount - 1
                ? t("Continuer")
                : guided
                  ? t("Enregistrer et continuer")
                  : t("Enregistrer et revenir au salaire")}
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
          guided={guided}
          onFix={navigate}
          onSaved={() => {
            onSaved();
            if (guided) {
              onClose();
              return;
            }
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
