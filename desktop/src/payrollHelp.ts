/** Presentation only: native decisions and their original explanation remain authoritative. */
export type PayrollHelpTarget =
  | 'person'
  | 'history'
  | 'insurance'
  | 'contributions'
  | 'pension-person'
  | 'pension-plan'
  | 'pension-contributions'
  | 'situation'
  | 'accounts'
  | 'advanced-contributions'
  | 'period'
  | 'salary'
  | 'review';
export type PayrollHelp = {
  title: string;
  explanation: string;
  target: PayrollHelpTarget;
  action: string;
  selector?: string;
  steps?: string[];
};
const rules: [RegExp, PayrollHelp][] = [
  [
    /source de chaque définition LPP|référence.*correspondre exactement/i,
    {
      title: 'Reliez la cotisation au règlement de pension',
      explanation:
        'Recopiez exactement la référence du règlement enregistrée dans les assurances de l’entreprise. Elle relie le montant du salarié au bon contrat de pension.',
      target: 'pension-contributions',
      selector: '[name=source]',
      action: 'Corriger la référence de pension',
    },
  ],
  [
    /dates réelles du contrat|dates.*cotisation|période d[’']effet de chaque définition/i,
    {
      title: 'Vérifiez les dates de cette cotisation',
      explanation:
        'Recopiez les dates de validité du contrat d’assurance. Pour la pension, elles doivent rester dans la période du règlement de l’entreprise.',
      target: 'contributions',
      selector: '[name=from]',
      action: 'Corriger les dates du contrat',
    },
  ],
  [
    /référence de contrat assez précise/i,
    {
      title: 'Indiquez le document qui justifie cette cotisation',
      explanation:
        'Recopiez une référence permettant de retrouver le taux ou le montant : assureur, numéro de police et année. Pour la pension, utilisez exactement la référence du règlement enregistrée pour l’entreprise.',
      target: 'contributions',
      selector: '[name=source]',
      action: 'Corriger la référence du contrat',
    },
  ],
  [
    /(?:date.*(?:décision|demande)|année d[’']évaluation).*petits salaires|date de décision\/demande|small_salary_decision_date/i,
    {
      title: 'Confirmez la date du choix de cotisation',
      explanation:
        'Cette date vient de la déclaration ou de la confirmation écrite concernant les cotisations du salarié. Elle doit appartenir à l’année de la fiche. Ne saisissez pas une date au hasard.',
      target: 'history',
      selector: '[name=decisionDate]',
      action: 'Corriger la date de confirmation',
    },
  ],
  [
    /momentanément|storage unavailable|SQLITE_BUSY|database locked|timeout|network/i,
    {
      title: 'Le chargement ou l’enregistrement a été interrompu',
      explanation:
        'Votre saisie reste dans cet écran. Réessayez avec le bouton de chargement ou d’enregistrement. Si cela échoue encore, transmettez le message détaillé au support.',
      target: 'review',
      action: '',
    },
  ],
  [
    /données.*changé|recalcul|changed|périm|stale/i,
    {
      title: 'Le salaire doit être recalculé',
      explanation:
        'Une information a changé depuis la dernière vérification. Relancez le calcul pour afficher le nouveau net avant d’enregistrer.',
      target: 'review',
      action: 'Revenir à la vérification',
    },
  ],
  [
    /Complétez la base|plusieurs éléments.*base|Classez comptablement la ligne/i,
    {
      title: 'Complétez le détail du salaire',
      explanation:
        'Ouvrez le détail pour corriger la ligne indiquée. La base est la partie du salaire soumise à cette assurance ; ce n’est pas le montant de la retenue.',
      target: 'salary',
      action: 'Ouvrir le détail du salaire',
    },
  ],
  [
    /Choisissez les cotisations applicables|sélectionnez le profil fédéral|retirez ces définitions/i,
    {
      title: 'Vérifiez les cotisations choisies pour ce mois',
      explanation:
        'Les contrats sont enregistrés, mais les cotisations choisies doivent correspondre au collaborateur et à ce mois. Reprenez les réglages de son profil, puis contrôlez le résultat.',
      target: 'salary',
      action: 'Choisir les cotisations du mois',
      selector: '[data-payroll-selection]',
    },
  ],
  [
    /(?:LPP|pension).*(?:uniquement 2026|couvre uniquement)|(?:période LPP|période de paie|payment_date|date de paiement|format AAAA-MM)/i,
    {
      title: 'Vérifiez le mois et la date de paiement',
      explanation:
        'Revenez au choix du mois. Le contrôle suisse intégré couvre 2026 ; une autre année nécessite un référentiel adapté.',
      target: 'period',
      action: 'Choisir le mois du salaire',
    },
  ],
  [
    /(?:évaluation salariale LPP|année d[’']évaluation.*LPP|salaire annuel.*(?:LPP|pension)|lpp_assessment_year|lpp_annual_salary)/i,
    {
      title: 'Complétez le salaire annuel pour la pension',
      explanation:
        'Dans le contrat du collaborateur, recopiez le salaire brut annuel annoncé à la caisse pour l’année de cette fiche. Ce n’est ni le salaire net, ni le salaire déjà réduit par la caisse.',
      target: 'pension-person',
      action: 'Renseigner le salaire annuel',
    },
  ],
  [
    /exception.*(?:LPP|contrat court)|(?:LPP|contrat déterminé).*exception|lpp_exception|âge de référence|reference_age|franchise AVS/i,
    {
      title: 'Confirmez la situation du collaborateur',
      explanation:
        'Complétez uniquement la situation confirmée par la caisse : retraite ou exception de pension, avec la référence du document. Une exception ne doit pas servir à contourner une information manquante.',
      target: 'situation',
      action: 'Compléter la situation particulière',
    },
  ],
  [
    /(?:plan LPP exige|règlement LPP exige|fenêtre du règlement LPP|fin du règlement LPP|contrat de pension incomplet|période du contrat de pension|lpp_plan|part employeur agrégée|règlement de pension.*référence)/i,
    {
      title: 'Complétez le contrat de la caisse de pension',
      explanation:
        'Prenez le contrat ou le règlement de prévoyance de l’entreprise. Indiquez son numéro, sa référence et ses dates de validité, puis confirmez la participation de l’employeur. Si un élément manque, demandez-le à votre caisse.',
      target: 'pension-plan',
      action: 'Ouvrir le contrat de pension',
    },
  ],
  [
    /caisse de pension.*manque|pension_fund/i,
    {
      title: 'Indiquez votre caisse de pension',
      explanation:
        'Recopiez le nom sur votre contrat d’affiliation. Choisir le nom de la caisse ne suffit pas : son contrat et les montants du collaborateur se complètent ensuite.',
      target: 'pension-plan',
      action: 'Compléter la caisse de pension',
    },
  ],
  [
    /(?:durée indéterminée ou déterminée|contrat.*durée déterminée.*date|fin du contrat|employment_contract|emploi.*début|rapports de travail)/i,
    {
      title: 'Vérifiez les dates du contrat de travail',
      explanation:
        'Indiquez s’il s’agit d’un CDI ou d’un CDD, le premier jour de travail et la fin prévue pour un CDD. Le mois du salaire doit correspondre à une période travaillée.',
      target: 'person',
      action: 'Ouvrir le contrat du collaborateur',
    },
  ],
  [
    /impôt.*source|source_tax/i,
    {
      title: 'Vérifiez l’impôt à la source',
      explanation:
        'Ouvrez les cotisations détaillées et complétez la retenue avec le barème officiel du canton et la situation du salarié.',
      target: 'advanced-contributions',
      action: 'Ouvrir les retenues détaillées',
    },
  ],
  [
    /(?:compte.*salair|wages_.*account)/i,
    {
      title: 'Choisissez les comptes du salaire',
      explanation:
        'Remplacez le compte indisponible par un compte actif : charges de personnel pour le salaire, dettes pour les salaires à payer. Revenez ensuite vérifier la fiche.',
      target: 'accounts',
      action: 'Corriger les comptes du salaire',
    },
  ],
  [
    /compte.*cotisation|(?:account|liability|expense)_.*(?:id|inactif)|définitions historiques|cotisation.*inactiv/i,
    {
      title: 'Vérifiez les réglages de la cotisation',
      explanation:
        'Ouvrez la cotisation concernée pour corriger son compte comptable ou son état. Les fiches déjà comptabilisées restent conservées.',
      target: 'advanced-contributions',
      action: 'Ouvrir les cotisations détaillées',
    },
  ],
  [
    /deux décimales/i,
    {
      title: 'Ce taux nécessite une précision supplémentaire',
      explanation:
        'Cette version accepte deux décimales en pourcentage. Ne modifiez pas le taux du contrat pour le faire accepter : conservez la fiche à contrôler et demandez le calcul exact à votre caisse ou fiduciaire.',
      target: 'contributions',
      action: 'Revoir la cotisation',
    },
  ],
  [
    /rate_bp|taux supérieur à zéro/i,
    {
      title: 'Vérifiez le taux de cotisation',
      explanation:
        'Recopiez le pourcentage exact de votre contrat, pour la part du salarié ou de l’entreprise choisie.',
      target: 'contributions',
      action: 'Revoir la cotisation',
      selector: '[name=rate]',
    },
  ],
  [
    /momentanément|storage unavailable|SQLITE_BUSY|database locked|timeout|network/i,
    {
      title: 'Les informations sont momentanément indisponibles',
      explanation:
        'Votre saisie reste conservée dans cet écran. Réessayez le chargement ou l’enregistrement dans un instant.',
      target: 'review',
      action: 'Revoir la fiche',
    },
  ],
  [
    /compte.*salair|wages_.*account/i,
    {
      title: 'Le compte comptable n’est plus utilisable',
      explanation:
        'Dans Comptabilité, vérifiez les comptes utilisés pour les salaires : le compte de charge et le compte des salaires à payer doivent être actifs. Relancez ensuite la vérification du salaire.',
      target: 'contributions',
      action: '',
    },
  ],
  [
    /date.*(naissance.*invalide|invalide.*naissance)/i,
    {
      title: 'Vérifiez la date de naissance',
      explanation:
        'Choisissez une date réelle dans le calendrier de la fiche collaborateur.',
      target: 'person',
      action: 'Corriger la date',
    },
  ],
  [
    /date de naissance|birth_date/i,
    {
      title: 'Indiquez la date de naissance',
      explanation:
        'Elle sert à choisir les cotisations liées à l’âge. Recopiez-la depuis une pièce d’identité.',
      target: 'person',
      action: 'Compléter le collaborateur',
    },
  ],
  [
    /date d[’']entrée|employment_start|date.*début.*contrat/i,
    {
      title: 'Indiquez le début du contrat',
      explanation:
        'Il s’agit du premier jour de travail dans votre entreprise.',
      target: 'person',
      action: 'Compléter le collaborateur',
    },
  ],
  [
    /horaire|contractual_weekly|8 h\/semaine|8.*heures.*semaine/i,
    {
      title: 'Vérifiez les heures de travail par semaine',
      explanation:
        'Recopiez l’horaire du contrat. L’assurance accidents en dehors du travail dépend notamment du seuil de 8 heures par semaine.',
      target: 'person',
      action: 'Vérifier les heures',
    },
  ],
  [
    /minime importance|petits salaires|small_salary|\bouverture\b|opening_|cumul.*antérieur/i,
    {
      title: 'Complétez les salaires établis avant Zentra',
      explanation:
        'Reprenez les salaires établis par votre entreprise avant Zentra cette année, même s’ils ne sont pas encore payés. Ne recopiez pas les fiches déjà présentes. Indiquez zéro seulement si aucun montant n’est à reprendre.',
      target: 'history',
      action: 'Renseigner le début d’année',
    },
  ],
  [
    /âge de référence|reference_age|franchise AVS/i,
    {
      title: 'Confirmez la situation à l’âge de la retraite',
      explanation:
        'La caisse AVS peut confirmer la date de référence et le choix concernant la franchise. Ces informations se renseignent dans la fiche collaborateur.',
      target: 'person',
      action: 'Vérifier le collaborateur',
    },
  ],
  [
    /caisse AVS|avs_fund/i,
    {
      title: 'Choisissez votre caisse AVS',
      explanation:
        'Son nom figure sur le courrier d’affiliation ou le décompte de cotisations de votre entreprise.',
      target: 'insurance',
      action: 'Choisir la caisse',
    },
  ],
  [
    /assureur.*manque|caisse.*manque|institution.*manque|accident_insurer|pension_fund/i,
    {
      title: 'Renseignez la caisse ou l’assurance',
      explanation:
        'Recherchez le nom indiqué sur le contrat de votre entreprise. Les primes restent celles de ce contrat.',
      target: 'insurance',
      action: 'Choisir les assurances',
    },
  ],
  [
    /LPP|BVG|coordinated|pension/i,
    {
      title: 'Vérifiez la caisse de pension',
      explanation:
        'Recopiez les cotisations du collaborateur et de l’employeur depuis le certificat de prévoyance. Elles dépendent du plan de votre entreprise.',
      target: 'pension-contributions',
      action: 'Régler les montants de pension',
    },
  ],
  [
    /AANP|AAP|LAA|IJM|CAF|allocations familiales|AVS|AI_|APG_|\bAC\b|cotisation|définition|definition_id/i,
    {
      title: 'Complétez les cotisations',
      explanation:
        'Les taux AVS et chômage peuvent être préparés avec le profil suisse. Les primes accidents, maladie et allocations doivent correspondre à vos contrats.',
      target: 'contributions',
      action: 'Préparer les cotisations',
    },
  ],
  [
    /impôt.*source|source_tax/i,
    {
      title: 'Vérifiez l’impôt à la source',
      explanation:
        'Le montant dépend du canton et de la situation du salarié. Reprenez le montant du barème officiel et sa référence.',
      target: 'contributions',
      action: 'Vérifier les retenues',
    },
  ],
  [
    /brut|gain positif|montant|gross_cents|income_|centimes|complément|ligne/i,
    {
      title: 'Vérifiez les montants du mois',
      explanation:
        'Indiquez le salaire avant retenues. Ajoutez séparément les primes, allocations et remboursements de frais.',
      target: 'salary',
      action: 'Revoir le salaire',
    },
  ],
  [
    /compt|account|liability|expense/i,
    {
      title: 'Complétez les comptes des cotisations',
      explanation:
        'Chaque retenue doit être reliée au bon compte pour préparer la comptabilité. Les réglages détaillés permettent de le choisir.',
      target: 'contributions',
      action: 'Vérifier les comptes',
    },
  ],
  [
    /données.*changé|recalcul|changed|périm|stale/i,
    {
      title: 'Actualisez le calcul',
      explanation:
        'Une information a changé. Revenez au salaire du mois puis relancez sa vérification.',
      target: 'salary',
      action: 'Recalculer le salaire',
    },
  ],
];

export function payrollHelp(message: string): PayrollHelp {
  const known = rules.find(([pattern]) => pattern.test(message))?.[1];
  if (known) return { ...known, steps: payrollSteps[known.target] };
  if (
    /^(Indiquez|Choisissez|Complétez|Vérifiez|Les assurances ont changé|La fiche collaborateur a changé|Cette cotisation a changé)/.test(
      message,
    ) &&
    !/[a-z]_[a-z]|SQLITE|\bnull\b|undefined/.test(message)
  )
    return {
      title: 'Une information est à compléter',
      explanation: message,
      target: 'review',
      action: 'Revoir la fiche',
    };
  return {
    title: 'Cette étape n’a pas pu être terminée',
    explanation:
      'Votre saisie reste dans cet écran. Réessayez. Si le problème persiste, ouvrez le détail pour transmettre le message au support.',
    target: 'review',
    action: 'Revoir la fiche',
  };
}

const payrollSteps: Partial<Record<PayrollHelpTarget, string[]>> = {
  person: [
    'Ouvrez le contrat signé ou la fiche du collaborateur.',
    'Complétez le champ indiqué, puis enregistrez pour revenir au salaire.',
  ],
  history: [
    'Vérifiez si des salaires de votre entreprise ont été établis avant Zentra cette année.',
    'Choisissez « Non » si aucun montant n’est à reprendre, sinon recopiez les cumuls du dernier décompte.',
    'Confirmez le choix de cotisation, sa date et le document utilisé.',
  ],
  insurance: [
    'Prenez le contrat d’affiliation ou le courrier de la caisse.',
    'Recopiez le nom de l’organisme ; les primes se renseignent séparément depuis le contrat.',
  ],
  contributions: [
    'Les taux fédéraux AVS et chômage se préparent avec le profil suisse inclus.',
    'Pour les autres assurances, recopiez votre contrat : part du salarié ou de l’entreprise, taux et dates.',
    'Revenez à la fiche et appliquez les cotisations proposées.',
  ],
  'pension-person': [
    'Prenez le certificat ou la confirmation de votre caisse de pension.',
    'Recopiez le salaire brut annuel annoncé pour cette personne et cette année.',
  ],
  'pension-plan': [
    'Prenez le contrat de prévoyance de l’entreprise.',
    'Complétez le numéro, la référence du règlement, ses dates et la confirmation de la participation employeur.',
  ],
  'pension-contributions': [
    'Sur le certificat du salarié, repérez les deux montants mensuels : salarié et employeur.',
    'Enregistrez chaque part séparément, avec sa couverture et la référence du règlement.',
    'Revenez au salaire pour appliquer les nouvelles cotisations et recalculer.',
  ],
  salary: [
    'Corrigez la ligne ou la cotisation concernée dans le détail.',
    'Cliquez sur « Vérifier le salaire » pour obtenir le nouveau montant net.',
  ],
  accounts: [
    'Choisissez un compte actif de charges de personnel et un compte de salaires à payer.',
    'Enregistrez, puis recalculez la fiche avant de confirmer.',
  ],
};

export function groupedPayrollHelp(messages: string[]) {
  const groups = new Map<string, PayrollHelp & { messages: string[] }>();
  for (const message of messages) {
    const help = payrollHelp(message);
    const group = groups.get(help.title) ?? { ...help, messages: [] };
    if (!group.messages.includes(message)) group.messages.push(message);
    groups.set(help.title, group);
  }
  return [...groups.values()];
}
