import type { AutopilotActionCard } from './AutopilotActionList';
import type { InboxItem, PublishedTask } from './openApi';

/**
 * Un assistant connecté (MCP) lit les cartes Autopilote et peut demander une
 * action, que l'app exécute ici comme un clic, inscrite au journal. Seules des
 * actions internes et réversibles le peuvent : la même liste qu'au serveur.
 * Envoyer un mail, une relance ou une lettre, enregistrer un paiement, émettre
 * une facture ou préparer une poursuite restent un clic dans l'app.
 */
export const ASSISTANT_ACTIONS: ReadonlySet<string> = new Set([
  'inbox-customer', 'inbox-quote', 'inbox-order', 'inbox-article', 'inbox-project', 'inbox-reject', 'inbox-noted',
  'create-client', 'update-record', 'add-appointment', 'ignore-appointment',
  'postpone', 'ignore', 'wait-promise', 'wait-habit', 'task-done', 'close',
]);

const KEY = /^[\x21-\x7e]{1,160}$/;
const ACTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const clip = (value: string | undefined, max: number) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Les cartes telles que le serveur les accepte (contrat fermé, 100 au plus). */
export function publishableTasks(cards: readonly AutopilotActionCard[], kindOf: (card: AutopilotActionCard) => string): PublishedTask[] {
  const seen = new Set<string>();
  const tasks: PublishedTask[] = [];
  for (const card of cards) {
    if (tasks.length >= 100 || !KEY.test(card.key) || seen.has(card.key)) continue;
    const title = clip(card.title, 300);
    if (!title) continue;
    const actions = card.actions.filter(action => ACTION_ID.test(action.id) && clip(action.label, 80)).slice(0, 8)
      .map(action => ({ id: action.id, label: clip(action.label, 80) }));
    seen.add(card.key);
    tasks.push({ key: card.key, kind: clip(kindOf(card), 60), title, detail: clip(card.detail, 600), why: clip(card.why, 600), actions,
      assistantActions: actions.filter(action => ASSISTANT_ACTIONS.has(action.id)).map(action => action.id) });
  }
  return tasks;
}

/** Empreinte d'une liste publiée : on ne republie que si elle change. */
export const tasksFingerprint = (tasks: readonly PublishedTask[]) => JSON.stringify(tasks);

export type TaskRequest = Readonly<{ itemId: string; taskKey: string; actionId: string }>;

/** Demande d'action déposée par l'assistant, lue dans la boîte d'entrée. */
export function taskRequest(item: InboxItem): TaskRequest | null {
  if (item.kind !== 'task_action') return null;
  const taskKey = typeof item.payload.taskKey === 'string' ? item.payload.taskKey : '';
  const actionId = typeof item.payload.actionId === 'string' ? item.payload.actionId : '';
  return KEY.test(taskKey) && ACTION_ID.test(actionId) ? { itemId: item.itemId, taskKey, actionId } : null;
}

/** Ce que l'app fera d'une demande : l'exécuter, ou la refuser avec un code court. */
export function taskDecision(request: TaskRequest | null, cards: readonly AutopilotActionCard[]): { run: true } | { run: false; reason: 'invalid' | 'task-missing' | 'action-refused' } {
  if (!request) return { run: false, reason: 'invalid' };
  if (!ASSISTANT_ACTIONS.has(request.actionId)) return { run: false, reason: 'action-refused' };
  const card = cards.find(row => row.key === request.taskKey);
  if (!card) return { run: false, reason: 'task-missing' };
  return card.actions.some(action => action.id === request.actionId) ? { run: true } : { run: false, reason: 'action-refused' };
}

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const cents = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Article reçu de l'assistant : le taux de TVA par défaut de l'entreprise s'il n'en donne pas. */
export function articleFromDraft(payload: Raw, defaultVatBp: number) {
  const article = record(payload.article);
  const name = text(article.name, 200);
  if (!name) return null;
  const vat = cents(article.vatBp);
  const kind: 'product' | 'service' = article.type === 'product' ? 'product' : 'service';
  return {
    kind, name, sku: text(article.sku, 80) || null, description: [text(article.description, 2000), text(payload.note, 2000)].filter(Boolean).join('\n'),
    unit: text(article.unit, 40) || (kind === 'service' ? 'h' : 'pce'), salesPriceCents: cents(article.unitPriceCents) ?? 0, purchaseCostCents: 0,
    vatBp: vat !== null && vat <= 10_000 ? vat : defaultVatBp, trackStock: false, reorderLevelMilli: 0, stockQuantityMilli: 0,
  };
}

/** Projet reçu de l'assistant, dans la forme du formulaire des projets. */
export function projectFromDraft(payload: Raw, clientId: string | null, today: string) {
  const project = record(payload.project);
  const name = text(project.name, 160);
  if (!name) return null;
  const start = text(project.plannedStart, 10), end = text(project.plannedEnd, 10);
  return {
    clientId, code: '', name, addressLine1: text(project.address, 300), addressLine2: '', postalCode: '', city: '', canton: '',
    status: 'planned', plannedStartDate: DAY.test(start) ? start : today, plannedEndDate: DAY.test(end) ? end : '', actualStartDate: '', actualEndDate: '',
    budgetCents: cents(project.budgetCents) ?? 0, plannedMinutes: 0, description: text(project.description, 2000), notes: text(payload.note, 2000),
  };
}
