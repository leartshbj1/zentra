import { useRef, useState, type FormEvent } from 'react';
import { Users } from 'lucide-react';
import { Button, Field, SectionHeading, ErrorPanel } from './ui';
import { PayrollOrganisationField } from './PayrollOrganisationField';
import { PayrollSelect } from './PayrollSelect';
import { SWISS_FAMILY_ALLOWANCES_2026 } from './swissFamilyAllowances2026';
import { usePayrollFieldGuide } from './PayrollFieldGuide';
import { payrollSettingsDraft, payrollSettingsIssue } from './payrollSettingsDraft';
import { t, useAppLanguage } from './language';
import { errorMessage } from './utils';
import type { AppSettings } from './types';
import { SETTINGS_READINESS_TARGETS } from './SetupReadinessCenter';
import './payroll-settings.css';

export function PayrollSettingsForm({ payroll, busy, onSave, onReload }: { payroll: AppSettings['payroll']; busy: boolean; onSave: (next: AppSettings['payroll']) => Promise<boolean>; onReload?: () => Promise<boolean> }) {
  useAppLanguage();
  const storedLppPlan = payroll.lppPlanEvidence;
  const storedLaaSmallSalaryException = payroll.laaSmallSalaryException;
  const [lppPlanEnabled, setLppPlanEnabled] = useState(Boolean(storedLppPlan));
  const [laaSmallSalaryExceptionEnabled, setLaaSmallSalaryExceptionEnabled] = useState(Boolean(storedLaaSmallSalaryException?.enabled));
  const [canton, setCanton] = useState(payroll.payrollCanton);
  const [error, setError] = useState('');
  const fieldGuide = usePayrollFieldGuide();
  const saving = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saving.current) return;
    const form = event.currentTarget;
    setError('');
    if (!fieldGuide.check(form)) return;
    const next = payrollSettingsDraft(payroll, new FormData(form), { pension: lppPlanEnabled, smallSalary: laaSmallSalaryExceptionEnabled });
    const issue = payrollSettingsIssue(next);
    if (issue) {
      const field = form.elements.namedItem(issue.field);
      if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) fieldGuide.reject(field, issue.message, issue.presentation);
      else setError(issue.message);
      return;
    }
    saving.current = true;
    try { if (!(await onSave(next))) setError('Les réglages n’ont pas pu être enregistrés. Votre saisie est conservée. Réessayez.'); }
    catch (reason) { setError(errorMessage(reason, 'Les réglages n’ont pas pu être enregistrés. Votre saisie est conservée. Réessayez.')); }
    finally { saving.current = false; }
  }
  return (
      <section
        id={SETTINGS_READINESS_TARGETS.payroll}
        className="panel settings-card settings-card--wide settings-scroll-target payroll-settings"
        tabIndex={-1}
      >
        <SectionHeading
          eyebrow={t("Paie")}
          title={t("Organismes et validation")}
          description={t("Renseignez vos organismes sociaux. Confirmez le contrôle de votre configuration uniquement après sa validation professionnelle. Les cotisations détaillées se trouvent plus bas.")}
        />
        <form noValidate onSubmit={submit}>
          {fieldGuide.guide}
          {error && <div className="payroll-settings__error"><ErrorPanel message="Les réglages n’ont pas pu être enregistrés. Votre saisie est conservée. Réessayez." reveal /><details><summary>{t('Voir le message détaillé')}</summary><p>{t(error)}</p></details>{onReload && <><Button type="button" variant="secondary" disabled={busy} onClick={() => void onReload()}>{t('Charger les derniers réglages enregistrés')}</Button><p>{t('En rechargeant, vous remplacez la saisie de ce formulaire par les réglages enregistrés.')}</p></>}</div>}
          <div className="form-grid">
            <label className="module-toggle module-toggle--compact">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={payroll.enabled}
              />
              <span>
                <Users size={19} />
                <strong>{t("Module salaires")}</strong>
                <small>{t("Activer la création des fiches")}</small>
              </span>
            </label>
            <label className="check-card">
              <input
                name="fiduciaryValidated"
                id="settings-payroll-review"
                type="checkbox"
                defaultChecked={payroll.fiduciaryValidated}
              />
              <span>
                <strong>{t("Configuration contrôlée par une fiduciaire")}</strong>
                <small>{t("À confirmer seulement après validation professionnelle.")}</small>
              </span>
            </label>
            <PayrollOrganisationField kind="avs" name="avsFund" defaultValue={payroll.avsFund} canton={canton} />
            <PayrollOrganisationField kind="accident" name="accidentInsurer" defaultValue={payroll.accidentInsurer} />
            <PayrollOrganisationField kind="pension" name="pensionFund" defaultValue={payroll.pensionFund} />
            <PayrollOrganisationField kind="daily" name="dailyAllowanceInsurer" defaultValue={payroll.dailyAllowanceInsurer} />
            <PayrollOrganisationField kind="family" name="familyAllowanceFund" defaultValue={payroll.familyAllowanceFund} canton={canton} />
            <Field label={t("Canton de paie")}>
              <PayrollSelect name="payrollCanton" value={canton} onChange={event => setCanton(event.target.value)}>
                <option value="">{t('À confirmer')}</option>
                {canton && !SWISS_FAMILY_ALLOWANCES_2026.some(item => item.canton === canton) && <option value={canton}>{canton}</option>}
                {SWISS_FAMILY_ALLOWANCES_2026.map(item => <option key={item.canton} value={item.canton}>{item.canton} · {t(item.name)}</option>)}
              </PayrollSelect>
            </Field>
            <details className="payroll-settings__contracts field--wide" open={Boolean(storedLppPlan || payroll.aanpEmployerCoverage?.enabled || storedLaaSmallSalaryException?.enabled)}><summary>{t("Contrats et exceptions")}</summary><p>{t("Ouvrez cette rubrique pour votre contrat de pension, une prise en charge AANP par l’entreprise ou une exception annuelle LAA.")}</p><div className="form-grid">
            <label className="check-card">
              <input
                name="aanpEmployerCoverageEnabled"
                type="checkbox"
                defaultChecked={payroll.aanpEmployerCoverage?.enabled}
              />
              <span>
                <strong>{t("Prime AANP prise en charge par l’employeur")}</strong>
                <small>{t("Uniquement avec une convention plus favorable écrite.")}</small>
              </span>
            </label>
            <Field
              label={t("Référence de la convention AANP")}
              hint={t("Le même texte devra être utilisé comme source de la définition AANP employeur.")}
              wide
            >
              <input
                name="aanpEmployerCoverageReference"
                maxLength={500}
                defaultValue={payroll.aanpEmployerCoverage?.reference ?? ''}
              />
            </Field>
            <Field label={t("Début de prise en charge AANP")}>
              <input
                name="aanpEmployerCoverageEffectiveFrom"
                type="date"
                defaultValue={payroll.aanpEmployerCoverage?.effectiveFrom ?? ''}
              />
            </Field>
            <Field label={t("Fin de prise en charge AANP")} hint={t("Facultatif.")}>
              <input
                name="aanpEmployerCoverageEffectiveTo"
                type="date"
                defaultValue={payroll.aanpEmployerCoverage?.effectiveTo ?? ''}
              />
            </Field>
            <label className="check-card field--wide">
              <input
                name="laaSmallSalaryExceptionEnabled"
                type="checkbox"
                checked={laaSmallSalaryExceptionEnabled}
                onChange={(event) =>
                  setLaaSmallSalaryExceptionEnabled(event.target.checked)
                }
              />
              <span>
                <strong>{t("Demander l’exception LAA annuelle des petits salaires")}</strong>
                <small>{t("Non cochée par défaut. Le moteur vérifie tous les salariés concernés pendant l’année et bloque l’exception dès qu’un dossier, un secteur ou un cumul ne la permet pas.")}</small>
              </span>
            </label>
            {laaSmallSalaryExceptionEnabled ? (
              <section className="settings-evidence-section field--wide">
                <div className="form-grid">
                  <Field label={t("Année de l’exception LAA")} required>
                    <input
                      name="laaSmallSalaryAssessmentYear"
                      type="number"
                      min="2000"
                      max="9999"
                      step="1"
                      defaultValue={
                        storedLaaSmallSalaryException?.assessmentYear ?? ''
                      }
                      required
                    />
                  </Field>
                  <Field
                    label={t("Référence de la preuve LAA")}
                    hint={t("Ex. contrôle annuel signé, décision de l’assureur ou dossier de la fiduciaire.")}
                    required
                  >
                    <input
                      name="laaSmallSalaryEvidenceReference"
                      maxLength={500}
                      defaultValue={
                        storedLaaSmallSalaryException?.evidenceReference ?? ''
                      }
                      required
                    />
                  </Field>
                  <label className="check-card field--wide">
                    <input
                      name="laaSmallSalaryAllEmployeesConfirmed"
                      type="checkbox"
                      defaultChecked={
                        storedLaaSmallSalaryException
                          ?.confirmedAllEmployeesOnlyMinorSalaries ?? false
                      }
                      required
                    />
                    <span>
                      <strong>{t("Tous les salariés concernés pendant l’année ont été contrôlés")}</strong>
                      <small>{t("Je confirme avoir vérifié aussi les personnes sorties de l’entreprise pendant l’année. Cette déclaration ne remplace pas le contrôle automatique et peut être refusée par le moteur.")}</small>
                    </span>
                  </label>
                </div>
              </section>
            ) : null}
            <label className="check-card field--wide">
              <input
                name="lppPlanEnabled"
                type="checkbox"
                checked={lppPlanEnabled}
                onChange={(event) =>
                  setLppPlanEnabled(event.target.checked)
                }
              />
              <span>
                <strong>{t("Configurer le règlement LPP de l’entreprise")}</strong>
                <small>{t("Activez seulement avec le contrat et le règlement réels de la caisse. Aucun taux n’est inventé.")}</small>
              </span>
            </label>
            {lppPlanEnabled ? (
              <>
                <Field label={t("Numéro du contrat LPP")} required>
                  <input
                    name="lppPlanContractNumber"
                    maxLength={200}
                    defaultValue={storedLppPlan?.contractNumber ?? ''}
                    required
                  />
                </Field>
                <Field
                  label={t("Référence exacte du règlement LPP")}
                  hint={t("Recopiez cette référence comme source de chaque définition LPP.")}
                  required
                  wide
                >
                  <input
                    name="lppPlanRegulationReference"
                    maxLength={500}
                    defaultValue={storedLppPlan?.regulationReference ?? ''}
                    required
                  />
                </Field>
                <Field label={t("Début d’effet du règlement LPP")} required>
                  <input
                    name="lppPlanEffectiveFrom"
                    type="date"
                    defaultValue={storedLppPlan?.effectiveFrom ?? ''}
                    required
                  />
                </Field>
                <Field label={t("Fin d’effet du règlement LPP")} required>
                  <input
                    name="lppPlanEffectiveTo"
                    type="date"
                    defaultValue={storedLppPlan?.effectiveTo ?? ''}
                    required
                  />
                </Field>
                <label className="check-card field--wide">
                  <input
                    name="lppPlanEmployerShareConfirmed"
                    type="checkbox"
                    defaultChecked={
                      storedLppPlan?.employerAggregateShareConfirmed ?? false
                    }
                    required
                  />
                  <span>
                    <strong>{t("Part employeur agrégée contrôlée dans le règlement")}</strong>
                    <small>{t("Je confirme que le total des contributions employeur est au moins égal au total des contributions des salariés, selon le règlement réel du plan.")}</small>
                  </span>
                </label>
              </>
            ) : null}

            </div></details>
          </div>
          <div className="form-actions">
            <Button disabled={busy} type="submit">{t("Enregistrer la paie")}</Button>
          </div>
        </form>
      </section>

  );
}
