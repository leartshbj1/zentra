import { payrollHelp, type PayrollHelp } from './payrollHelp';

export type PayrollPreparationTask = PayrollHelp & {
  id: string;
  document: string;
  messages: string[];
};
const documents: Record<string, string> = {
  person: 'Le contrat de travail et la date de naissance',
  history:
    'Le dernier décompte de cette année, ou la confirmation du début d’activité',
  insurance: 'Le courrier d’affiliation de votre entreprise',
  'pension-person': 'Le certificat de prévoyance de cette personne',
  'pension-plan':
    'Le contrat d’affiliation et le règlement de la caisse de pension',
  'pension-contributions':
    'Le certificat de prévoyance : part salarié et part entreprise',
  contributions: 'Le contrat ou le décompte de votre assurance',
  accounts: 'Le plan comptable de votre entreprise',
};
const order = [
  'period',
  'person',
  'history',
  'insurance',
  'pension-person',
  'pension-plan',
  'contributions',
  'pension-contributions',
  'situation',
  'salary',
  'accounts',
  'advanced-contributions',
  'review',
];

/** Orders actual eligibility messages; it never replaces the native payroll checks. */
export function payrollPreparationTasks(
  messages: string[],
): PayrollPreparationTask[] {
  const tasks = new Map<string, PayrollPreparationTask>();
  for (const message of messages.filter(Boolean)) {
    let help = payrollHelp(message);
    let id = help.target as string;
    if (help.target === 'contributions') {
      const preset = /\bAANP\b/i.test(message)
        ? 'aanp'
        : /\bAAP\b|\bLAA\b/i.test(message)
          ? 'aap'
          : /CAF|allocations familiales/i.test(message)
            ? 'family_allowance'
            : /IJM/i.test(message)
              ? 'ijm'
              : /\bAVS\b|AVS_|\bAI\b|AI_|APG|\bAC\b|AC_|fédéral/i.test(message)
                ? 'federal'
                : '';
      if (preset) {
        id = `contributions-${preset}`;
        help = { ...help, selector: `[data-payroll-preset="${preset}"]` };
        if (preset === 'federal')
          help = {
            ...help,
            title: 'Préparer les taux AVS et chômage',
            explanation:
              'Les taux fédéraux sont déjà fournis par Zentra. Un bouton prépare les cotisations manquantes pour votre entreprise.',
            action: 'Préparer les taux suisses',
          };
        else {
          const label = {
            aap: 'les accidents au travail',
            aanp: 'les accidents hors travail',
            family_allowance: 'les allocations familiales',
            ijm: 'la perte de gain maladie',
          }[preset];
          help = {
            ...help,
            title: `Renseigner ${label}`,
            explanation:
              'Recopiez le taux exact et les dates de votre contrat. Zentra réutilisera ce réglage pour les prochaines fiches.',
            action: 'Ouvrir cette assurance',
          };
        }
      }
    }
    const current = tasks.get(id);
    if (current) {
      if (!current.messages.includes(message)) current.messages.push(message);
      continue;
    }
    tasks.set(id, {
      ...help,
      id,
      messages: [message],
      document:
        id === 'contributions-federal'
          ? 'Aucun document à rechercher : les taux fédéraux sont intégrés.'
          : (documents[help.target] ??
            'Le document correspondant au point indiqué'),
    });
  }
  return [...tasks.values()].sort(
    (a, b) => order.indexOf(a.target) - order.indexOf(b.target),
  );
}
