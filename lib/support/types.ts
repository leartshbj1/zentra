export const CATEGORIES = {
  bug: 'Bug',
  billing: 'Facturation',
  supplier_invoice: 'Factures fournisseurs',
  appointment: 'Rendez-vous',
  order: 'Commandes',
  after_sales: 'Service après-vente',
  complaint: 'Réclamations',
  administration: 'Administratif',
  human_resources: 'Ressources humaines',
  spam: 'Indésirables',
  quote: 'Devis et offres',
  credit_note: 'Avoirs',
  payment_reminder: 'Rappels de paiement',
  receipt: 'Reçus de paiement',
  product: 'Question produit',
  refund: 'Remboursement',
  shipping: 'Livraison',
  account: 'Compte et accès',
  other: 'Autre',
} as const;
export const PRIORITIES = {
  low: 'Basse',
  normal: 'Normale',
  high: 'Élevée',
  urgent: 'Urgente',
} as const;
export type Category = keyof typeof CATEGORIES;
export type Priority = keyof typeof PRIORITIES;
export type Provider =
  | 'zendesk'
  | 'freshdesk'
  | 'gorgias'
  | 'api'
  | 'infomaniak';
export type Destination = { teamId: string; agentId?: string };
export type Directory = {
  teams: { id: string; name: string }[];
  agents: { id: string; name: string }[];
};
export type Rules = Partial<Record<Category, Destination>>;
export const LANGUAGES = {
  fr: 'Français',
  de: 'Allemand',
  it: 'Italien',
  en: 'Anglais',
  other: 'Autre / indéterminée',
} as const;
export type Decision = {
  category: Category;
  priority: Priority;
  confidence: number;
  categoryConfidence: number;
  priorityConfidence: number;
  probabilities: Record<string, number>;
  model: string;
  policyVersion?: string;
  inputTokens: number;
  destination: Destination | null;
  reason: string;
  manual?: boolean;
  signals?: {
    language: keyof typeof LANGUAGES;
    languageConfidence: number;
    frustration: number;
    frustrationConfidence: number;
    humanRequested: number;
  };
};
export type SourceTicket = {
  mail?: {
    sender: string;
    calendarText?: string;
    uid?: string;
    attachments: { id: string; name: string; size: number }[];
    attachmentCount?: number;
    bodyIncomplete?: boolean;
    analysisText?: string;
  };
  externalId: string;
  subject: string;
  body: string;
  version: string;
  groupId: string | null;
  agentId: string | null;
  priority?: Priority;
  closed: boolean;
  incomplete?: boolean;
  incompleteReason?: string;
};
export type Workspace = {
  id: string;
  owner_id: string;
  name: string;
  triage_context: string;
  mode: 'automatic' | 'review' | 'paused';
  threshold: number;
  baseline_seconds: number;
  ai_secret: string | null;
  created_at: number;
  updated_at: number;
};
export type Connection = {
  id: string;
  workspace_id: string;
  provider: Provider;
  label: string;
  domain: string;
  login: string;
  secret: string;
  hook_hash: string;
  directory_json: string;
  routes_json: string;
  active: number;
  created_at: number;
};
export type Ticket = {
  id: string;
  workspace_id: string;
  connection_id: string;
  external_id: string;
  subject: string;
  body: string;
  source_json: string;
  fingerprint: string;
  revision: number;
  state: 'pending' | 'processing' | 'review' | 'ready' | 'routed' | 'error';
  decision_json: string | null;
  error: string | null;
  attempts: number;
  lease: string | null;
  lease_until: number | null;
  automatic: number;
  corrected: number;
  created_at: number;
  updated_at: number;
  routed_at: number | null;
};
export class SupportError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
export function externalId(value: unknown): string {
  const s = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s))
    throw new SupportError('Identifiant du ticket invalide.');
  return s;
}
export function numericId(value: unknown): string {
  const s = String(value ?? '');
  if (!/^[1-9]\d{0,14}$/.test(s))
    throw new SupportError('Identifiant de l’équipe ou de l’agent invalide.');
  return s;
}
