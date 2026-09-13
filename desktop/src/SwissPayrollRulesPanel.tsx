import { t, getAppLocale, useAppLanguage } from './language';
import { payrollText, renderPayrollText, type PayrollPresentationRegistry } from './payrollPresentation';
import './payroll-settings.css';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, LoaderCircle, ShieldAlert } from 'lucide-react';
import { desktopApi } from './bridge';
import { assessSwissFederalProfile } from './payrollEligibility';
import { familyAllowanceReferenceForCanton, SWISS_FAMILY_ALLOWANCES_2026, SWISS_FAMILY_ALLOWANCES_2026_SOURCE } from './swissFamilyAllowances2026';
import {
  assessSwissPayrollInsuranceReadiness,
  SWISS_INSURANCE_SOURCES,
  swissPayrollReferenceDate,
} from './swissPayrollInsuranceReadiness';
import type { AppSettings, ContributionCategory, Employee, PayrollContributionDefinition } from './types';
import { ErrorPanel, SectionHeading } from './ui';
import { errorMessage } from './utils';

type RuleStatus = 'included' | 'configured' | 'missing' | 'external' | 'local';
type Rule = {
  id: string;
  title: string;
  value: string;
  applicability: string;
  configuration: string | string[];
  source: string;
  category?: ContributionCategory;
  status: RuleStatus;
};

const sources = {
  federal2026: 'https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf',
  lpp: 'https://www.bsv.admin.ch/dam/bsv/fr/dokumente/bv/anleitungen/masszahlen-2025-2026.pdf.download.pdf/masszahlen-2025-2026.pdf',
  family: SWISS_FAMILY_ALLOWANCES_2026_SOURCE,
  sourceTax: 'https://www.estv.admin.ch/fr/baremes-impot-a-la-source-importation-systemes-de-comptabilite-salariale',
  swissdec: 'https://www.swissdec.ch/standards',
  swissdecVersions: 'https://www.swissdec.ch/fr/abschaltung-elm-4-0',
  accidentCoverage: SWISS_INSURANCE_SOURCES.accidentCoverage,
};

const statusLabels: Record<RuleStatus, string> = {
  local: 'Export local disponible',
  included: 'Référentiel inclus',
  configured: 'Configuration présente',
  missing: 'Configuration requise',
  external: 'Traitement externe requis',
};

const categoryLabels: Record<ContributionCategory, string> = {
  avs_ai_apg: 'Cotisations fédérales', ac: 'Assurance-chômage', lpp: 'Prévoyance professionnelle', aap: 'Accidents professionnels', aanp: 'Accidents non professionnels',
  ijm: 'Indemnité journalière maladie', family_allowance: 'Allocations familiales', source_tax: 'Impôt à la source', other: 'Autre cotisation',
};

const SWISS_RULES_YEAR = 2026;

export function SwissPayrollRulesPanel({ settings, asOf, refreshKey = 0 }: { settings: AppSettings; asOf?: string; refreshKey?: number }) {
  useAppLanguage();
  const [data, setData] = useState<{ referenceDate: string; definitions: PayrollContributionDefinition[]; employees: Employee[] } | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const referenceDate = useMemo(() => asOf?.trim() || swissPayrollReferenceDate(), [asOf]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    void Promise.all([
      desktopApi.listPayrollContributionDefinitions(referenceDate),
      desktopApi.loadWorkspace(),
    ])
      .then(([items, workspace]) => {
        if (!alive) return;
        setData({ referenceDate, definitions: items.filter((item) => item.active), employees: workspace.employees });
      })
      .catch((reason) => { if (alive) setError(errorMessage(reason, 'Le contrôle du référentiel de paie a échoué.')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [referenceDate, revision, refreshKey]);

  const pending = loading || data?.referenceDate !== referenceDate;
  const { rules, presentations } = useMemo(() => {
    const definitions = data?.referenceDate === referenceDate ? data.definitions : [];
    const employees = data?.referenceDate === referenceDate ? data.employees : [];
    const presentations: PayrollPresentationRegistry = new Map();
    const has = (category: ContributionCategory) => definitions.some((definition) => definition.category === category);
    const configured = (category: ContributionCategory, organization: string) => has(category) && Boolean(organization.trim());
    const federal = assessSwissFederalProfile(definitions);
    const insurance = assessSwissPayrollInsuranceReadiness({
      settings,
      definitions,
      employees,
      asOf: referenceDate,
    }, presentations);
    const issueText = (issues: string[], success: string) =>
      issues.length ? issues : success;
    const rules: Rule[] = [
      { id: 'avs', title: 'AVS / AI / APG', value: '5,30 % employé + 5,30 % employeur', applicability: 'Dès le 1er janvier suivant 17 ans. Après l’âge de référence: franchise facultative de CHF 16’800/an; pas d’AC.', configuration: federal.avsAiApgComplete ? 'Les six codes, les deux parts et les totaux 5,30 % sont présents.' : 'Installez ou corrigez les six lignes AVS/AI/APG officielles. Une seule ligne de la catégorie ne suffit pas.', source: sources.federal2026, category: 'avs_ai_apg', status: federal.avsAiApgComplete ? 'configured' : 'missing' },
      { id: 'ac', title: 'Assurance-chômage', value: '1,10 % par part · plafond CHF 148’200/an', applicability: 'Plafond par contrat à proratiser en cas d’année d’emploi partielle; aucune AC après l’âge de référence.', configuration: federal.acComplete ? 'Les deux parts à 1,10 % et leur plafond annuel sont présentes. Confirmez l’ouverture annuelle sur le collaborateur; les fiches Zentra antérieures sont cumulées automatiquement.' : 'Installez ou corrigez AC employé et AC employeur, chacune à 1,10 % avec plafond CHF 148’200.', source: sources.federal2026, category: 'ac', status: federal.acComplete ? 'configured' : 'missing' },
      { id: 'lpp', title: 'Prévoyance professionnelle LPP', value: 'Seuil CHF 22’680 · coordination CHF 26’460', applicability: 'Risque dès l’année suivant 17 ans, épargne dès l’année suivant 24 ans; salaire coordonné légal entre CHF 3’780 et CHF 64’260.', configuration: 'Le plan réel, le surobligatoire, le risque, les frais et la répartition viennent de la caisse. Les bonifications 7/10/15/18 % ne sont pas un taux universel de retenue.', source: sources.lpp, category: 'lpp', status: configured('lpp', settings.payroll.pensionFund) ? 'configured' : 'missing' },
      { id: 'aap', title: 'Accidents professionnels AAP', value: 'Gain assuré max. CHF 148’200/an', applicability: 'Obligatoire pour chaque salarié. La prime AAP est entièrement à charge de l’employeur.', configuration: issueText(insurance.aap.issues, 'Assureur, taux de police, plafond, assiette, source et côté employeur sont cohérents.'), source: sources.accidentCoverage, category: 'aap', status: insurance.aap.complete ? 'configured' : 'missing' },
      { id: 'aanp', title: 'Accidents non professionnels AANP', value: 'Dès 8 h/semaine chez le même employeur', applicability: 'En règle générale à charge du salarié; une prise en charge employeur exige une convention plus favorable écrite et datée.', configuration: issueText(insurance.aanp.issues, insurance.aanp.required === false ? 'Aucun salarié actif n’atteint actuellement le seuil de 8 heures confirmé.' : 'Le taux de police, le plafond et la répartition sont cohérents pour les salariés concernés.'), source: sources.accidentCoverage, category: 'aanp', status: insurance.aanp.complete ? insurance.aanp.required === false ? 'included' : 'configured' : 'missing' },
      { id: 'family', title: 'Allocations familiales', value: 'Minimum 2026: CHF 215 enfant · CHF 268 formation/mois', applicability: 'Droit dès CHF 630/mois ou CHF 7’560/an; priorité entre parents et différences intercantonales à vérifier.', configuration: issueText(insurance.familyAllowance.issues, 'Canton, caisse et financement employeur sont documentés; la part salarié Valais est contrôlée séparément.'), source: sources.family, category: 'family_allowance', status: insurance.familyAllowance.complete ? 'configured' : 'missing' },
      { id: 'ijm', title: 'Indemnité journalière maladie', value: 'Aucun taux fédéral universel', applicability: 'Facultative au niveau fédéral, mais une CCT ou un contrat peut l’imposer.', configuration: issueText(insurance.dailyAllowance.issues, 'Décidez l’applicabilité avec le contrat de travail, la CCT et la police; Zentra n’invente aucun taux.'), source: SWISS_INSURANCE_SOURCES.dailyAllowance, category: 'ijm', status: insurance.dailyAllowance.configured ? 'missing' : 'external' },
      { id: 'qst', title: 'Impôt à la source', value: 'Barèmes cantonaux progressifs officiels 2026', applicability: 'Canton, permis, état civil, enfants, conjoint, église, autres emplois et modèle annuel/mensuel influencent le calcul.', configuration: 'Zentra n’applique pas un faux pourcentage. Jusqu’à l’import vérifié des fichiers cantonaux, le montant doit être calculé par un système officiel puis saisi comme retenue contrôlée.', source: sources.sourceTax, category: 'source_tax', status: 'external' },
      { id: 'elm', title: 'Transmission Swissdec ELM', value: 'Déclarations 2026: ELM 5.0+ · cas particuliers 5.1/5.3', applicability: 'ELM 4.0 n’est plus admis pour les déclarations portant sur 2026. ELM 5.1 est requis pour transmettre la renonciation à la franchise AVS; ELM 5.3 couvre les frontaliers de France et devient obligatoire pour ce cas en 2027.', configuration: 'Zentra n’est pas certifié Swissdec et ne transmet pas de déclarations ELM. ELM 6.0 a été publié en mars 2026. La transmission nécessite une intégration et une certification distinctes du certificat de salaire local.', source: sources.swissdecVersions, status: 'external' },
      { id: 'certificate', title: 'Certificat de salaire annuel', value: 'Formulaire officiel 11 · export PDF local', applicability: 'Préparez le certificat à partir des fiches de salaire et contrôlez les rubriques fiscales, les avantages et les frais.', configuration: 'L’export du certificat est disponible dans Équipe et paie. Relisez les données avant de remettre le PDF au collaborateur. Aucun envoi à une administration ni aucune transmission Swissdec n’est effectué.', source: 'https://www.estv.admin.ch/fr/certificat-de-salaire-et-attestation-de-rentes', status: 'local' },
    ];
    return { rules, presentations };
  }, [data, referenceDate, settings]);
  const display = (message: string) => renderPayrollText(payrollText(presentations, message), getAppLocale(), (source, values) => t(source, values));

  const companyCanton = settings.organization.address.canton.trim().toUpperCase();
  const companyAllowance = familyAllowanceReferenceForCanton(companyCanton);
  const currentYear = new Date().getFullYear();
  const referenceExpired = currentYear > SWISS_RULES_YEAR;

  return <section className="panel settings-card settings-card--wide swiss-rules"><SectionHeading eyebrow={t("Règles suisses 2026 · situation au {date}", { date: referenceDate })} title={t("Couverture réglementaire vérifiable")} description={t("Les règles nationales sont séparées des taux de caisse, de contrat et de canton. Chaque source et limite reste visible pour la date contrôlée.")} />
    {referenceExpired ? <ErrorPanel message={t("Le référentiel intégré est verrouillé sur {year}. Il est expiré pour {current} : n’établissez aucune paie avant d’avoir installé et validé le nouveau millésime.", { year: SWISS_RULES_YEAR, current: currentYear })} /> : null}
    {pending && !error ? <div className="swiss-rules__loading"><LoaderCircle className="spin" size={18} />{t("Contrôle de la configuration locale…")}</div> : null}
    {error ? <ErrorPanel message={error} onRetry={() => setRevision(value => value + 1)} /> : null}
    {!pending && !error && <div className="swiss-rules__grid">{rules.map((rule) => <article key={rule.id} className={`swiss-rule swiss-rule--${rule.status}`}><header><div><span>{t(rule.category ? categoryLabels[rule.category] : 'Référentiel')}</span><strong>{t(rule.title)}</strong></div><em>{rule.status === 'configured' || rule.status === 'included' || rule.status === 'local' ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}{t(statusLabels[rule.status])}</em></header><h3>{t(rule.value)}</h3><dl><div><dt>{t("Quand")}</dt><dd>{t(rule.applicability)}</dd></div><div><dt>{t("À renseigner")}</dt><dd>{Array.isArray(rule.configuration) ? <ul>{rule.configuration.map(message => <li key={message}>{display(message)}</li>)}</ul> : t(rule.configuration)}</dd></div></dl><a href={rule.source} target="_blank" rel="noreferrer">{t("Source officielle")}<ExternalLink size={13} /></a></article>)}</div>}
    <details className="swiss-family-reference">
      <summary><span><strong>{t("Allocations pour enfant et de formation · 2026")}</strong><small>{t("26 cantons · ces deux catégories mensuelles officielles")}</small></span><em>{companyAllowance ? t("Siège {canton} · repère enfant {child} · formation {education}", { canton: companyAllowance.canton, child: companyAllowance.child, education: companyAllowance.education }) : companyCanton ? t("Canton du siège {canton} · à vérifier", { canton: companyCanton }) : t("Canton du siège non renseigné")}</em></summary>
      <div className="swiss-family-reference__notice"><ShieldAlert size={16} /><p>{t("Le canton du siège est surligné comme simple repère. Il ne sélectionne pas automatiquement le barème applicable : le lieu d’activité ou l’établissement, la caisse compétente, la situation du salarié, l’ordre de priorité entre parents, le nombre d’enfants, l’âge et les droits acquis déterminent le montant réellement versé.")}</p></div>
      <div className="swiss-family-reference__table-wrap"><table><thead><tr><th>{t("Canton")}</th><th>{t("Allocation pour enfant")}</th><th>{t("Allocation de formation")}</th><th>{t("Particularité")}</th></tr></thead><tbody>{SWISS_FAMILY_ALLOWANCES_2026.map((item) => <tr key={item.canton} className={item.canton === companyCanton ? 'is-company-canton' : undefined}><td><strong>{item.canton}</strong><span>{t(item.name)}</span></td><td data-label={t("Allocation pour enfant")}>{item.child}</td><td data-label={t("Allocation de formation")}>{item.education}</td><td data-label={t("Particularité")}>{t(item.note || "Barème standard publié")}</td></tr>)}</tbody></table></div>
      <a href={SWISS_FAMILY_ALLOWANCES_2026_SOURCE} target="_blank" rel="noreferrer">{t("Tableau cantonal officiel 2026")}<ExternalLink size={13} /></a>
    </details>
    <div className="swiss-rules__notice"><ShieldAlert size={18} /><div><strong>{t("Validation professionnelle nécessaire")}</strong><p>{t("Une case “validé” ne remplace pas la confirmation de votre caisse, assureur, CCT ou fiduciaire. Zentra conserve les paramètres utilisés sur chaque fiche pour rendre le calcul contrôlable.")}</p></div></div>
  </section>;
}
