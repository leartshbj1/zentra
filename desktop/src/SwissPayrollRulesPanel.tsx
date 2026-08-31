import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, LoaderCircle, ShieldAlert } from 'lucide-react';
import { desktopApi } from './bridge';
import { assessSwissFederalProfile } from './payrollEligibility';
import type { AppSettings, ContributionCategory, PayrollContributionDefinition } from './types';
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
  lpp: 'https://www.bsv.admin.ch/dam/fr/sd-web/CEMzEhplKCJn/f_kmu_2026_def.pdf',
  family: 'https://www.bsv.admin.ch/fr/allocations-familiales-prestations-et-conditions',
  sourceTax: 'https://www.estv.admin.ch/fr/baremes-impot-a-la-source-importation-systemes-de-comptabilite-salariale',
  swissdec: 'https://www.swissdec.ch/fr/elm',
};

const statusLabels: Record<RuleStatus, string> = {
  included: 'Référentiel inclus',
  configured: 'Configuration présente',
  missing: 'Configuration requise',
  external: 'Traitement externe requis',
};

export function SwissPayrollRulesPanel({ settings }: { settings: AppSettings }) {
  const [definitions, setDefinitions] = useState<PayrollContributionDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const now = new Date();
    const today = [
      now.getFullYear().toString().padStart(4, '0'),
      (now.getMonth() + 1).toString().padStart(2, '0'),
      now.getDate().toString().padStart(2, '0'),
    ].join('-');
    void desktopApi.listPayrollContributionDefinitions(today)
      .then((items) => { if (alive) setDefinitions(items.filter((item) => item.active)); })
      .catch((reason) => { if (alive) setError(errorMessage(reason, 'Le contrôle du référentiel de paie a échoué.')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const rules = useMemo<Rule[]>(() => {
    const has = (category: ContributionCategory) => definitions.some((definition) => definition.category === category);
    const configured = (category: ContributionCategory, organization: string) => has(category) && Boolean(organization.trim());
    const federal = assessSwissFederalProfile(definitions);
    return [
      { id: 'avs', title: 'AVS / AI / APG', value: '5,30 % employé + 5,30 % employeur', applicability: 'Dès le 1er janvier suivant 17 ans. Après l’âge de référence: franchise facultative de CHF 16’800/an; pas d’AC.', configuration: federal.avsAiApgComplete ? 'Les six codes, les deux parts et les totaux 5,30 % sont présents.' : 'Installez ou corrigez les six lignes AVS/AI/APG officielles. Une seule ligne de la catégorie ne suffit pas.', source: sources.federal2026, category: 'avs_ai_apg', status: federal.avsAiApgComplete ? 'configured' : 'missing' },
      { id: 'ac', title: 'Assurance-chômage', value: '1,10 % par part · plafond CHF 148’200/an', applicability: 'Plafond par contrat à proratiser en cas d’année d’emploi partielle; aucune AC après l’âge de référence.', configuration: federal.acComplete ? 'Les deux parts à 1,10 % et leur plafond annuel sont présentes. Confirmez l’ouverture annuelle sur le collaborateur; les fiches Elyko antérieures sont cumulées automatiquement.' : 'Installez ou corrigez AC employé et AC employeur, chacune à 1,10 % avec plafond CHF 148’200.', source: sources.federal2026, category: 'ac', status: federal.acComplete ? 'configured' : 'missing' },
      { id: 'lpp', title: 'Prévoyance professionnelle LPP', value: 'Seuil CHF 22’680 · coordination CHF 26’460', applicability: 'Risque dès l’année suivant 17 ans, épargne dès l’année suivant 24 ans; salaire coordonné légal entre CHF 3’780 et CHF 64’260.', configuration: 'Le plan réel, le surobligatoire, le risque, les frais et la répartition viennent de la caisse. Les bonifications 7/10/15/18 % ne sont pas un taux universel de retenue.', source: sources.lpp, category: 'lpp', status: configured('lpp', settings.payroll.pensionFund) ? 'configured' : 'missing' },
      { id: 'laa', title: 'Assurance-accidents LAA', value: 'Gain assuré max. CHF 148’200/an', applicability: 'AAP pour tous les salariés; AANP dès 8 h/semaine chez le même employeur.', configuration: 'Saisir l’assureur, la classe de risque, la prime en ‰ convertie explicitement, et qui supporte l’AANP.', source: sources.federal2026, status: configured('aap', settings.payroll.accidentInsurer) && configured('aanp', settings.payroll.accidentInsurer) ? 'configured' : 'missing' },
      { id: 'family', title: 'Allocations familiales', value: 'Minimum 2026: CHF 215 enfant · CHF 268 formation/mois', applicability: 'Droit dès CHF 630/mois ou CHF 7’560/an; priorité entre parents et différences intercantonales à vérifier.', configuration: 'Le taux de financement dépend du canton et de la caisse. Les montants versés dépendent des enfants et de leur formation.', source: sources.family, category: 'family_allowance', status: configured('family_allowance', settings.payroll.familyAllowanceFund) ? 'configured' : 'missing' },
      { id: 'ijm', title: 'Indemnité journalière maladie', value: 'Aucun taux fédéral universel', applicability: 'Facultative au niveau fédéral, mais une CCT ou un contrat peut l’imposer.', configuration: 'Saisir la police, la couverture, le délai d’attente, la durée, le taux et la répartition employeur/employé.', source: 'https://www.bag.admin.ch/fr/assurance-maladie-lassurance-facultative-dindemnites-journalieres', category: 'ijm', status: configured('ijm', settings.payroll.dailyAllowanceInsurer) ? 'configured' : 'missing' },
      { id: 'qst', title: 'Impôt à la source', value: 'Barèmes cantonaux progressifs officiels 2026', applicability: 'Canton, permis, état civil, enfants, conjoint, église, autres emplois et modèle annuel/mensuel influencent le calcul.', configuration: 'Elyko n’applique pas un faux pourcentage. Jusqu’à l’import vérifié des fichiers cantonaux, le montant doit être calculé par un système officiel puis saisi comme retenue contrôlée.', source: sources.sourceTax, category: 'source_tax', status: 'external' },
      { id: 'elm', title: 'Swissdec ELM et certificat annuel', value: 'ELM 5/6 · certificat de salaire formulaire 11', applicability: 'La fiche mensuelle ne remplace ni la transmission ELM ni le certificat annuel.', configuration: 'Elyko n’est pas certifié Swissdec et ne génère pas encore le formulaire 11. Aucune mention de certification ne doit être faite.', source: sources.swissdec, status: 'external' },
    ];
  }, [definitions, settings.payroll]);

  return <section className="panel settings-card settings-card--wide swiss-rules"><SectionHeading eyebrow="Règles suisses 2026" title="Couverture réglementaire vérifiable" description="Les règles nationales sont séparées des taux de caisse, de contrat et de canton. Chaque source et limite reste visible." />
    {loading ? <div className="swiss-rules__loading"><LoaderCircle className="spin" size={18} /> Contrôle de la configuration locale…</div> : null}
    {error ? <ErrorPanel message={error} /> : null}
    <div className="swiss-rules__grid">{rules.map((rule) => <article key={rule.id} className={`swiss-rule swiss-rule--${rule.status}`}><header><div><span>{rule.category ? rule.category.replaceAll('_', ' ') : 'référentiel'}</span><strong>{rule.title}</strong></div><em>{rule.status === 'configured' || rule.status === 'included' ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}{statusLabels[rule.status]}</em></header><h3>{rule.value}</h3><dl><div><dt>Quand</dt><dd>{rule.applicability}</dd></div><div><dt>À renseigner</dt><dd>{rule.configuration}</dd></div></dl><a href={rule.source} target="_blank" rel="noreferrer">Source officielle <ExternalLink size={13} /></a></article>)}</div>
    <div className="swiss-rules__notice"><ShieldAlert size={18} /><div><strong>Validation professionnelle nécessaire</strong><p>Une case “validé” ne remplace pas la confirmation de votre caisse, assureur, CCT ou fiduciaire. Elyko conserve les paramètres utilisés sur chaque fiche pour rendre le calcul contrôlable.</p></div></div>
  </section>;
}
