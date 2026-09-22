import type { Decision, Directory, Provider, Rules } from '@/lib/support/types';
import type { SupportBillingState } from '@/lib/support/plans';
export type SupportTicket = {
  id: string;
  connectionId: string;
  externalId: string;
  subject: string;
  body: string;
  revision: number;
  state: string;
  decision: Decision | null;
  error: string | null;
  automatic: boolean;
  corrected: boolean;
  createdAt: number;
  updatedAt: number;
  routedAt: number | null;
};
export type SupportConnection = {
  id: string;
  provider: Provider;
  label: string;
  domain: string;
  directory: Directory;
  rules: Rules;
  active: boolean;
  hookUrl: string;
};
export type SupportState = {
  automation?: {active:boolean;enabled:boolean};
  gestion?: { linked:boolean;organizationId:string|null;autoPost:boolean;choices:{id:string;name:string}[] };
  mailSync?: { background: boolean };
  billing?: SupportBillingState;
  zendesk?: { ready: boolean };
  user: { name: string; email: string };
  platformOwner: boolean;
  workspaces: { id: string; name: string; role: string }[];
  workspace: {
    id: string;
    name: string;
    mode: string;
    threshold: number;
    baselineSeconds: number;
    triageContext: string;
    role: string;
    canManage: boolean;
    aiReady: boolean;
  } | null;
  connections: SupportConnection[];
  mailboxes?: {
    connectionId: string;
    email: string;
    lastSyncAt: number | null;
    lastError: string | null;
    nextSyncAt: number;
  }[];
  tickets: SupportTicket[];
  hasMore: boolean;
  counts: {
    total: number;
    review: number;
    errors: number;
    ready: number;
    routed: number;
    automatic: number;
    corrections: number;
  };
  members: { id: string; email: string; role: string }[];
  events: {
    id: string;
    ticketId: string | null;
    kind: string;
    detail: string;
    actor: string;
    createdAt: number;
  }[];
};
export type Mutate = (
  body: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;
export const PROVIDERS = {
  infomaniak: 'Infomaniak Mail',
  zendesk: 'Zendesk',
  freshdesk: 'Freshdesk',
  gorgias: 'Gorgias',
  api: 'Autre outil · API',
};
export const STATES: Record<string, string> = {
  pending: 'En attente',
  processing: 'Analyse en cours',
  review: 'À vérifier',
  ready: 'À appliquer par votre outil',
  routed: 'Affecté',
  error: 'À reprendre',
};
export const emptyState: SupportState = {
  user: { name: '', email: '' },
  platformOwner: false,
  workspaces: [],
  workspace: null,
  connections: [],
  tickets: [],
  hasMore: false,
  counts: {
    total: 0,
    review: 0,
    errors: 0,
    ready: 0,
    routed: 0,
    automatic: 0,
    corrections: 0,
  },
  members: [],
  events: [],
};
export function demoState(): SupportState {
  const time = Math.floor(Date.now() / 1000),
    directory = {
      teams: [
        { id: 'finance', name: 'Facturation' },
        { id: 'tech', name: 'Support technique' },
        { id: 'care', name: 'Relation client' },
        { id: 'logistics', name: 'Logistique' },
      ],
      agents: [],
    };
  const drafts = [
    {
      id: '1048',
      subject: 'Double prélèvement sur ma commande',
      body: 'Bonjour, ma commande de lundi a été débitée deux fois. Pouvez-vous vérifier les deux paiements et me dire comment obtenir le remboursement du doublon ? Merci.',
      category: 'refund',
      priority: 'high',
      team: 'finance',
      confidence: 0.97,
    },
    {
      id: '1049',
      subject: 'Impossible de payer depuis ce matin',
      body: 'Le paiement affiche une erreur pour tous nos clients. Notre boutique ne peut plus recevoir de commandes depuis 8 h.',
      category: 'bug',
      priority: 'urgent',
      team: 'tech',
      confidence: 0.99,
    },
    {
      id: '1050',
      subject: 'Une question sur mon abonnement',
      body: 'Je voudrais changer, mais je ne sais pas si je dois récupérer ce que j’ai payé. Pouvez-vous m’aider ?',
      category: 'other',
      priority: 'normal',
      team: 'care',
      confidence: 0.48,
    },
    {
      id: '1051',
      subject: 'Où est ma commande ?',
      body: 'Le colis annoncé hier n’est pas arrivé. Avez-vous des nouvelles du transporteur ?',
      category: 'shipping',
      priority: 'normal',
      team: 'logistics',
      confidence: 0.96,
    },
  ];
  return {
    ...emptyState,
    user: { name: 'Camille', email: 'exemple@entreprise.test' },
    workspaces: [{ id: 'demo', name: 'Atelier — exemple', role: 'owner' }],
    workspace: {
      id: 'demo',
      name: 'Atelier — exemple',
      mode: 'automatic',
      threshold: 85,
      baselineSeconds: 60,
      triageContext: '',
      role: 'owner',
      canManage: true,
      aiReady: true,
    },
    connections: [
      {
        id: 'demo-connection',
        provider: 'zendesk',
        label: 'Support — exemple',
        domain: 'exemple.zendesk.com',
        directory,
        rules: {
          bug: { teamId: 'tech' },
          billing: { teamId: 'finance' },
          refund: { teamId: 'finance' },
          shipping: { teamId: 'logistics' },
          product: { teamId: 'care' },
          account: { teamId: 'tech' },
        },
        active: true,
        hookUrl: '',
      },
    ],
    tickets: drafts.map((d, i) => ({
      id: d.id,
      externalId: d.id,
      connectionId: 'demo-connection',
      subject: d.subject,
      body: d.body,
      revision: 1,
      state: d.confidence < 0.85 ? 'review' : 'routed',
      decision: {
        category: d.category,
        priority: d.priority,
        confidence: d.confidence,
        categoryConfidence: d.confidence,
        priorityConfidence: d.confidence,
        probabilities: {},
        model: 'Simulation',
        inputTokens: 0,
        destination: { teamId: d.team },
        reason:
          d.confidence < 0.85
            ? 'La demande ne permet pas de choisir une catégorie avec assez de confiance.'
            : 'Exemple de décision au-dessus du seuil choisi.',
      } as Decision,
      automatic: d.confidence >= 0.85,
      corrected: false,
      error: null,
      createdAt: time - i * 200,
      updatedAt: time - i * 200,
      routedAt: d.confidence >= 0.85 ? time - i * 200 : null,
    })),
    counts: {
      total: 4,
      review: 1,
      errors: 0,
      ready: 0,
      routed: 3,
      automatic: 3,
      corrections: 0,
    },
    events: [
      {
        id: 'example-event',
        ticketId: '1048',
        kind: 'routed',
        detail: 'Exemple : affectation à l’équipe Facturation.',
        actor: 'Simulation',
        createdAt: time,
      },
    ],
  };
}
