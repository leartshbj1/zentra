/** Presentation only: native decisions and their original explanation remain authoritative. */
export type PayrollHelpTarget =
  | 'person'
  | 'history'
  | 'insurance'
  | 'contributions'
  | 'salary'
  | 'review';
export type PayrollHelp = {
  title: string;
  explanation: string;
  target: PayrollHelpTarget;
  action: string;
};
const rules: [RegExp, PayrollHelp][] = [
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
    /minime importance|petits salaires|small_salary|ouverture|opening_|cumul.*antérieur/i,
    {
      title: 'Complétez les salaires déjà versés cette année',
      explanation:
        'Les montants d’avant Zentra sont nécessaires pour éviter de prélever trop ou trop peu de cotisations. Indiquez zéro seulement si aucun montant n’est à reprendre.',
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
      target: 'contributions',
      action: 'Régler la caisse de pension',
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
  if (known) return known;
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
