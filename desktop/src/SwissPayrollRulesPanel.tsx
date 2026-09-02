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

type RuleStatus = 'included' | 'configured' | 'missing' | 'external';
type Rule = {
  id: string;
  title: string;
  value: string;
  applicability: string;
  configuration: string;
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
  included: 'Référentiel inclus',
  configured: 'Configuration présente',
  missing: 'Configuration requise',
  external: 'Traitement externe requis',
};

const SWISS_RULES_YEAR = 2026;

export function SwissPayrollRulesPanel({ settings, asOf }: { settings: AppSettings; asOf?: string }) {
  const [definitions, setDefinitions] = useState<PayrollContributionDefinition[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const referenceDate = useMemo(() => asOf?.trim() || swissPayrollReferenceDate(), [asOf]);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      desktopApi.listPayrollContributionDefinitions(referenceDate),
      desktopApi.loadWorkspace(),
    ])
      .then(([items, workspace]) => {
        if (!alive) return;
        setDefinitions(items.filter((item) => item.active));
        setEmployees(workspace.employees);
      })
      .catch((reason) => { if (alive) setError(errorMessage(reason, 'Le contrôle du référentiel de paie a échoué.')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [referenceDate]);

  const rules = useMemo<Rule[]>(() => {
    const has = (category: ContributionCategory) => definitions.some((definition) => definition.category === category);
    const configured = (category: ContributionCategory, organization: string) => has(category) && Boolean(organization.trim());
    const federal = assessSwissFederalProfile(definitions);
    const insurance = assessSwissPayrollInsuranceReadiness({
      settings,
      definitions,
      employees,
      asOf: referenceDate,
    });
    const issueText = (issues: string[], success: string) =>
      issues.length ? issues.join(' ') : success;
    return [
      { id: 'avs', title: 'AVS / AI / APG', value: '5,30 % employé + 5,30 % employeur', applicability: 'Dès le 1er janvier suivant 17 ans. Après l’âge de référence: franchise facultative de CHF 16’800/an; pas d’AC.', configuration: federal.avsAiApgComplete ? 'Les six codes, les deux parts et les totaux 5,30 % sont présents.' : 'Installez ou corrigez les six lignes AVS/AI/APG officielles. Une seule ligne de la catégorie ne suffit pas.', source: sources.federal2026, category: 'avs_ai_apg', status: federal.avsAiApgComplete ? 'configured' : 'missing' },
      { id: 'ac', title: 'Assurance-chômage', value: '1,10 % par part · plafond CHF 148’200/an', applicability: 'Plafond par contrat à proratiser en cas d’année d’emploi partielle; aucune AC après l’âge de référence.', configuration: federal.acComplete ? 'Les deux parts à 1,10 % et leur plafond annuel sont présentes. Confirmez l’ouverture annuelle sur le collaborateur; les fiches Zentra antérieures sont cumulées automatiquement.' : 'Installez ou corrigez AC employé et AC employeur, chacune à 1,10 % avec plafond CHF 148’200.', source: sources.federal2026, category: 'ac', status: federal.acComplete ? 'configured' : 'missing' },
      { id: 'lpp', title: 'Prévoyance professionnelle LPP', value: 'Seuil CHF 22’680 · coordination CHF 26’460', applicability: 'Risque dès l’année suivant 17 ans, épargne dès l’année suivant 24 ans; salaire coordonné légal entre CHF 3’780 et CHF 64’260.', configuration: 'Le plan réel, le surobligatoire, le risque, les frais et la répartition viennent de la caisse. Les bonifications 7/10/15/18 % ne sont pas un taux universel de retenue.', source: sources.lpp, category: 'lpp', status: configured('lpp', settings.payroll.pensionFund) ? 'configured' : 'missing' },
      { id: 'aap', title: 'Accidents professionnels AAP', value: 'Gain assuré max. CHF 148’200/an', applicability: 'Obligatoire pour chaque salarié. La prime AAP est entièrement à charge de l’employeur.', configuration: issueText(insurance.aap.issues, 'Assureur, taux de police, plafond, assiette, source et côté employeur sont cohérents.'), source: sources.accidentCoverage, category: 'aap', status: insurance.aap.complete ? 'configured' : 'missing' },
      { id: 'aanp', title: 'Accidents non professionnels AANP', value: 'Dès 8 h/semaine chez le même employeur', applicability: 'En règle générale à charge du salarié; une prise en charge employeur exige une convention plus favorable écrite et datée.', configuration: issueText(insurance.aanp.issues, insurance.aanp.required === false ? 'Aucun salarié actif n’atteint actuellement le seuil de 8 heures confirmé.' : 'Le taux de police, le plafond et la répartition sont cohérents pour les salariés concernés.'), source: sources.accidentCoverage, category: 'aanp', status: insurance.aanp.complete ? insurance.aanp.required === false ? 'included' : 'configured' : 'missing' },
      { id: 'family', title: 'Allocations familiales', value: 'Minimum 2026: CHF 215 enfant · CHF 268 formation/mois', applicability: 'Droit dès CHF 630/mois ou CHF 7’560/an; priorité entre parents et différences intercantonales à vérifier.', configuration: issueText(insurance.familyAllowance.issues, 'Canton, caisse et financement employeur sont documentés; la part salarié Valais est contrôlée séparément.'), source: sources.family, category: 'family_allowance', status: insurance.familyAllowance.complete ? 'configured' : 'missing' },
      { id: 'ijm', title: 'Indemnité journalière maladie', value: 'Aucun taux fédéral universel', applicability: 'Facultative au niveau fédéral, mais une CCT ou un contrat peut l’imposer.', configuration: issueText(insurance.dailyAllowance.issues, 'Décidez l’applicabilité avec le contrat de travail, la CCT et la police; Zentra n’invente aucun taux.'), source: SWISS_INSURANCE_SOURCES.dailyAllowance, category: 'ijm', status: insurance.dailyAllowance.configured ? 'missing' : 'external' },
      { id: 'qst', title: 'Impôt à la source', value: 'Barèmes cantonaux progressifs officiels 2026', applicability: 'Canton, permis, état civil, enfants, conjoint, église, autres emplois et modèle annuel/mensuel influencent le calcul.', configuration: 'Zentra n’applique pas un faux pourcentage. Jusqu’à l’import vérifié des fichiers cantonaux, le montant doit être calculé par un système officiel puis saisi comme retenue contrôlée.', source: sources.sourceTax, category: 'source_tax', status: 'external' },
      { id: 'elm', title: 'Swissdec ELM et certificat annuel', value: 'Déclarations 2026: ELM 5.0+ · cas particuliers 5.1/5.3', applicability: 'ELM 4.0 n’est plus admis pour les déclarations portant sur 2026. ELM 5.1 est requis pour transmettre la renonciation à la franchise AVS; ELM 5.3 couvre les frontaliers de France et devient obligatoire pour ce cas en 2027.', configuration: 'Zentra n’est pas certifié Swissdec et ne génère pas encore le formulaire 11. ELM 6.0 a été publié en mars 2026; préparer un adaptateur versionné et une certification externe avant toute revendication.', source: sources.swissdecVersions, status: 'external' },
    ];
  }, [definitions, employees, referenceDate, settings]);

  const companyCanton = settings.organization.address.canton.trim().toUpperCase();
  const companyAllowance = familyAllowanceReferenceForCanton(companyCanton);
  const currentYear = new Date().getFullYear();
  const referenceExpired = currentYear > SWISS_RULES_YEAR;

  return <section className="panel settings-card settings-card--wide swiss-rules"><SectionHeading eyebrow={`Règles suisses 2026 · situation au ${referenceDate}`} title="Couverture réglementaire vérifiable" description="Les règles nationales sont séparées des taux de caisse, de contrat et de canton. Chaque source et limite reste visible pour la date contrôlée." />
    {referenceExpired ? <ErrorPanel message={`Le référentiel intégré est verrouillé sur ${SWISS_RULES_YEAR}. Il est expiré pour ${currentYear} : n'établissez aucune paie avant d'avoir installé et validé le nouveau millésime.`} /> : null}
    {loading ? <div className="swiss-rules__loading"><LoaderCircle className="spin" size={18} /> Contrôle de la configuration locale…</div> : null}
    {error ? <ErrorPanel message={error} /> : null}
    <div className="swiss-rules__grid">{rules.map((rule) => <article key={rule.id} className={`swiss-rule swiss-rule--${rule.status}`}><header><div><span>{rule.category ? rule.category.replaceAll('_', ' ') : 'référentiel'}</span><strong>{rule.title}</strong></div><em>{rule.status === 'configured' || rule.status === 'included' ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}{statusLabels[rule.status]}</em></header><h3>{rule.value}</h3><dl><div><dt>Quand</dt><dd>{rule.applicability}</dd></div><div><dt>À renseigner</dt><dd>{rule.configuration}</dd></div></dl><a href={rule.source} target="_blank" rel="noreferrer">Source officielle <ExternalLink size={13} /></a></article>)}</div>
    <details className="swiss-family-reference">
      <summary><span><strong>Allocations pour enfant et de formation · 2026</strong><small>26 cantons · ces deux catégories mensuelles officielles</small></span><em>{companyAllowance ? `Siège ${companyAllowance.canton} · repère enfant ${companyAllowance.child} · formation ${companyAllowance.education}` : companyCanton ? `Canton du siège ${companyCanton} · à vérifier` : 'Canton du siège non renseigné'}</em></summary>
      <div className="swiss-family-reference__notice"><ShieldAlert size={16} /><p>Le canton du siège est surligné comme simple repère. Il ne sélectionne pas automatiquement le barème applicable : le lieu d’activité ou l’établissement, la caisse compétente, la situation du salarié, l’ordre de priorité entre parents, le nombre d’enfants, l’âge et les droits acquis déterminent le montant réellement versé.</p></div>
      <div className="swiss-family-reference__table-wrap"><table><thead><tr><th>Canton</th><th>Allocation pour enfant</th><th>Allocation de formation</th><th>Particularité</th></tr></thead><tbody>{SWISS_FAMILY_ALLOWANCES_2026.map((item) => <tr key={item.canton} className={item.canton === companyCanton ? 'is-company-canton' : undefined}><td><strong>{item.canton}</strong><span>{item.name}</span></td><td>{item.child}</td><td>{item.education}</td><td>{item.note || 'Barème standard publié'}</td></tr>)}</tbody></table></div>
      <a href={SWISS_FAMILY_ALLOWANCES_2026_SOURCE} target="_blank" rel="noreferrer">Tableau cantonal officiel 2026 <ExternalLink size={13} /></a>
    </details>
    <div className="swiss-rules__notice"><ShieldAlert size={18} /><div><strong>Validation professionnelle nécessaire</strong><p>Une case “validé” ne remplace pas la confirmation de votre caisse, assureur, CCT ou fiduciaire. Zentra conserve les paramètres utilisés sur chaque fiche pour rendre le calcul contrôlable.</p></div></div>
  </section>;
}
