import { AccountPublicError } from '@/lib/account-security';
import { CATEGORIES, PRIORITIES } from '@/lib/support/types';

export const WORKFLOW_MODES = {
  shadow: 'Observer sans agir',
  suggest: 'Me demander de confirmer',
  automatic: 'Exécuter si la confiance suffit',
  notify: 'Exécuter puis notifier',
} as const;
export const WORKFLOW_ACTIONS = {
  task: 'Créer une tâche',
  notify: 'Notifier dans Automation',
  reply_draft: 'Préparer une réponse',
  summary: 'Résumer le message reçu',
  review: 'Demander une vérification',
} as const;
export type WorkflowDefinition = {
  trigger: 'email_classified';
  mode: keyof typeof WORKFLOW_MODES;
  threshold: number;
  conditions: {
    category: string;
    priority: string;
    sender: string;
    attachment: boolean;
  };
  decision: { question: string; yes: string; no: string } | null;
  actions: {
    type: keyof typeof WORKFLOW_ACTIONS;
    title: string;
    body: string;
    delayHours: number;
    branch: 'always' | 'yes' | 'no';
    assignedTo: string;
  }[];
};
const text = (v: unknown, max: number) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
const invalid = () =>
  new AccountPublicError(
    'Complétez le déclencheur, les conditions et au moins une action valide.',
  );
export function workflowDefinition(raw: unknown): WorkflowDefinition {
  if (!raw || typeof raw !== 'object') throw invalid();
  const d = raw as WorkflowDefinition;
  if (
    d.trigger !== 'email_classified' ||
    !Object.hasOwn(WORKFLOW_MODES, d.mode) ||
    !Number.isFinite(d.threshold) ||
    d.threshold < 0.8 ||
    d.threshold > 1
  )
    throw invalid();
  if (
    !d.conditions ||
    !['', ...Object.keys(CATEGORIES)].includes(d.conditions.category) ||
    !['', ...Object.keys(PRIORITIES)].includes(d.conditions.priority) ||
    typeof d.conditions.attachment !== 'boolean'
  )
    throw invalid();
  const sender = text(d.conditions.sender, 254).toLowerCase();
  if (sender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender))
    throw new AccountPublicError(
      'Indiquez une adresse e-mail complète pour l’expéditeur.',
    );
  let decision: WorkflowDefinition['decision'] = null;
  if (d.decision) {
    const question = text(d.decision.question, 500),
      yes = text(d.decision.yes, 200),
      no = text(d.decision.no, 200);
    if (!question || !yes || !no || yes === no)
      throw new AccountPublicError(
        'Décrivez la décision et deux réponses différentes.',
      );
    decision = { question, yes, no };
  }
  if (!Array.isArray(d.actions) || !d.actions.length || d.actions.length > 8)
    throw invalid();
  const actions = d.actions.map((a) => {
    if (
      !a ||
      !Object.hasOwn(WORKFLOW_ACTIONS, a.type) ||
      !['always', 'yes', 'no'].includes(a.branch) ||
      (!decision && a.branch !== 'always') ||
      !Number.isInteger(a.delayHours) ||
      a.delayHours < 0 ||
      a.delayHours > 720
    )
      throw invalid();
    const title = text(a.title, 160),
      body = text(a.body, 4000),
      assignedTo = text(a.assignedTo, 160);
    if (!title)
      throw new AccountPublicError('Donnez un titre à chaque action.');
    if (a.type === 'reply_draft' && !body)
      throw new AccountPublicError('Écrivez le modèle de réponse à préparer.');
    return {
      type: a.type,
      title,
      body,
      delayHours: a.delayHours,
      branch: a.branch,
      assignedTo,
    };
  });
  return {
    trigger: d.trigger,
    mode: d.mode,
    threshold: d.threshold,
    conditions: {
      category: d.conditions.category,
      priority: d.conditions.priority,
      sender,
      attachment: d.conditions.attachment,
    },
    decision,
    actions,
  };
}
export type MailWorkflowContext = {
  subject: string;
  body: string;
  sender: string;
  category: string;
  priority: string;
  confidence: number;
  attachments: string[];
};
export function workflowMatches(d: WorkflowDefinition, c: MailWorkflowContext) {
  return (
    (!d.conditions.category || d.conditions.category === c.category) &&
    (!d.conditions.priority || d.conditions.priority === c.priority) &&
    (!d.conditions.sender ||
      d.conditions.sender === c.sender.trim().toLowerCase()) &&
    (!d.conditions.attachment || c.attachments.length > 0)
  );
}
/** Only explicit values from the source are substituted. No model-generated prose or HTML. */
export function renderWorkflowText(template: string, c: MailWorkflowContext) {
  const values: Record<string, string> = {
    objet: c.subject,
    expediteur: c.sender,
    categorie:
      CATEGORIES[c.category as keyof typeof CATEGORIES] || 'À vérifier',
    priorite: PRIORITIES[c.priority as keyof typeof PRIORITIES] || 'À vérifier',
  };
  return template
    .replace(
      /\{\{(objet|expediteur|categorie|priorite)\}\}/g,
      (_, key: string) => values[key],
    )
    .slice(0, 4000);
}
export const WORKFLOW_TEMPLATES: {
  id: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
}[] = [
  {
    id: 'after_sales',
    name: 'Préparer le suivi SAV',
    description: 'Une demande SAV crée une tâche pour votre équipe.',
    definition: {
      trigger: 'email_classified',
      mode: 'suggest',
      threshold: 0.95,
      conditions: {
        category: 'after_sales',
        priority: '',
        sender: '',
        attachment: false,
      },
      decision: null,
      actions: [
        {
          type: 'task',
          title: 'SAV · {{objet}}',
          body: 'Vérifier la demande de {{expediteur}} et préparer l’intervention.',
          delayHours: 0,
          branch: 'always',
          assignedTo: '',
        },
      ],
    },
  },
  {
    id: 'urgent',
    name: 'Suivre les demandes urgentes',
    description:
      'Une demande urgente apparaît dans les notifications de l’équipe.',
    definition: {
      trigger: 'email_classified',
      mode: 'shadow',
      threshold: 0.98,
      conditions: {
        category: '',
        priority: 'urgent',
        sender: '',
        attachment: false,
      },
      decision: null,
      actions: [
        {
          type: 'notify',
          title: 'Demande urgente · {{objet}}',
          body: 'Message reçu de {{expediteur}}. Vérifier le ticket avant de répondre.',
          delayHours: 0,
          branch: 'always',
          assignedTo: '',
        },
      ],
    },
  },
  {
    id: 'quote',
    name: 'Préparer un rappel commercial',
    description: 'Un devis reçu crée une tâche de suivi pour le lendemain.',
    definition: {
      trigger: 'email_classified',
      mode: 'suggest',
      threshold: 0.95,
      conditions: {
        category: 'quote',
        priority: '',
        sender: '',
        attachment: false,
      },
      decision: null,
      actions: [
        {
          type: 'task',
          title: 'Suivre le devis · {{objet}}',
          body: 'Reprendre contact avec {{expediteur}} après vérification du dossier.',
          delayHours: 24,
          branch: 'always',
          assignedTo: '',
        },
      ],
    },
  },
  {
    id: 'acknowledgement',
    name: 'Préparer un accusé de réception',
    description: 'Un brouillon modifiable, jamais envoyé sans intervention.',
    definition: {
      trigger: 'email_classified',
      mode: 'suggest',
      threshold: 0.95,
      conditions: { category: '', priority: '', sender: '', attachment: false },
      decision: null,
      actions: [
        {
          type: 'reply_draft',
          title: 'Réponse · {{objet}}',
          body: 'Bonjour,\n\nNous avons bien reçu votre message concernant « {{objet}} ». Notre équipe examine votre demande.\n\nMeilleures salutations',
          delayHours: 0,
          branch: 'always',
          assignedTo: '',
        },
      ],
    },
  },
  {
    id: 'summary',
    name: 'Retenir les informations utiles',
    description:
      'Retrouver les passages importants et les pièces jointes du message reçu.',
    definition: {
      trigger: 'email_classified',
      mode: 'suggest',
      threshold: 0.95,
      conditions: { category: '', priority: '', sender: '', attachment: false },
      decision: null,
      actions: [
        {
          type: 'summary',
          title: 'À retenir · {{objet}}',
          body: '',
          delayHours: 0,
          branch: 'always',
          assignedTo: '',
        },
      ],
    },
  },
];
