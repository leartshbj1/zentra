import { diagnosticInvoke as invoke } from './diagnostics';

/**
 * Lot 5 « Ouverture et caisse » : commandes natives de la caisse, de la
 * projection publiée pour l'API, de la boîte d'entrée des brouillons et du
 * courrier Pingen. Les réponses du serveur sont vérifiées côté natif
 * (version 1, même entreprise) ; on ne garde ici que les champs connus.
 */

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export type OpenApiStatus = Readonly<{
  projection: Readonly<{ wanted: boolean; revision: number; publishedAt: string | null }>;
  inboxPending: number;
  postal: Readonly<{ configured: boolean; mode: 'staging' | 'production' | null }>;
  /** Un lien d'agenda existe : l'app publie ses rendez-vous pour Google, Outlook ou Apple. */
  calendarWanted: boolean;
}>;

export type InboxSource = 'api' | 'mcp' | 'shopify' | 'woocommerce';
export type InboxKind = 'customer' | 'quote' | 'order' | 'payment' | 'order_cancelled' | 'article' | 'project' | 'task_action' | 'supplier' | 'appointment' | 'project_task' | 'invoice' | 'work_note';
export type InboxItem = Readonly<{ itemId: string; seq: number; source: InboxSource; kind: InboxKind; createdAt: string; payload: Raw }>;

const SOURCES: readonly InboxSource[] = ['api', 'mcp', 'shopify', 'woocommerce'];
const KINDS: readonly InboxKind[] = ['customer', 'quote', 'order', 'payment', 'order_cancelled', 'article', 'project', 'task_action', 'supplier', 'appointment', 'project_task', 'invoice', 'work_note'];

export function statusFromRaw(raw: unknown): OpenApiStatus {
  const value = record(raw), projection = record(value.projection), postal = record(value.postal), inbox = record(value.inbox), calendar = record(value.calendar);
  const mode = postal.mode === 'staging' || postal.mode === 'production' ? postal.mode : null;
  return {
    projection: { wanted: projection.wanted === true, revision: count(projection.revision), publishedAt: text(projection.publishedAt) || null },
    inboxPending: count(inbox.pending),
    postal: { configured: postal.configured === true, mode },
    calendarWanted: calendar.wanted === true,
  };
}

/** Éléments de la boîte d'entrée ; un élément d'un type inconnu est ignoré. */
export function inboxFromRaw(raw: unknown): InboxItem[] {
  const items = record(raw).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((entry) => {
    const item = record(entry);
    const source = SOURCES.find((value) => value === item.source), kind = KINDS.find((value) => value === item.kind);
    if (!source || !kind || !/^in_[0-9a-f-]{36}$/.test(text(item.itemId))) return [];
    return [{ itemId: text(item.itemId), seq: count(item.seq), source, kind, createdAt: text(item.createdAt), payload: record(item.payload) }];
  });
}

export type PublishedTask = Readonly<{ key: string; kind: string; title: string; detail: string; why: string; actions: readonly Readonly<{ id: string; label: string }>[]; assistantActions: readonly string[] }>;

export type CalendarEventInput = Readonly<{ id: string; title: string; startDate: string; endDate: string; allDay: boolean; startTime: string | null; endTime: string | null; location: string; status: 'scheduled' | 'completed' | 'cancelled'; updatedAt: string }>;

export type DirectoryEntry = Readonly<{ kind: 'project' | 'supplier'; id: string; name: string; detail: string; status: string }>;

export type PostalLetter = Readonly<{
  letterId: string; documentId: string; status: string; providerStatus: string | null;
  mode: string; delivery: string; priceCents: number | null; priceCurrency: string | null; error: string | null; createdAt: string;
}>;

export function letterFromRaw(raw: unknown): PostalLetter {
  const value = record(raw);
  return {
    letterId: text(value.letterId), documentId: text(value.documentId), status: text(value.status), providerStatus: text(value.providerStatus) || null,
    mode: text(value.mode), delivery: text(value.delivery), priceCents: typeof value.priceCents === 'number' ? value.priceCents : null,
    priceCurrency: text(value.priceCurrency) || null, error: text(value.error) || null, createdAt: text(value.createdAt),
  };
}

export const openApi = {
  async status(): Promise<OpenApiStatus> {
    return statusFromRaw(await invoke('public_api_status'));
  },
  /** Publie les changements de la projection ; `reset` repart de zéro. */
  async publish(reset = false): Promise<{ published: number; deleted: number; remaining: number }> {
    const raw = record(await invoke('public_api_publish', { reset }));
    return { published: count(raw.published), deleted: count(raw.deleted), remaining: count(raw.remaining) };
  },
  async inbox(): Promise<InboxItem[]> {
    return inboxFromRaw(await invoke('public_api_inbox'));
  },
  async decide(itemId: string, decision: 'imported' | 'rejected', reference?: string | null) {
    await invoke('public_api_inbox_decide', { itemId, decision, reference: reference ?? null });
  },
  /** Remplace les tâches Autopilote que lit l'assistant connecté (MCP). */
  async publishTasks(items: readonly PublishedTask[]): Promise<number> {
    return count(record(await invoke('public_api_tasks', { items })).stored);
  },
  /** Remplace les rendez-vous de l'agenda d'abonnement (Google, Outlook, Apple). */
  async publishCalendar(events: readonly CalendarEventInput[]): Promise<number> {
    return count(record(await invoke('public_api_calendar', { events })).stored);
  },
  /** Remplace l'annuaire léger (projets, fournisseurs) que lit l'assistant connecté. */
  async publishDirectory(entries: readonly DirectoryEntry[]): Promise<number> {
    return count(record(await invoke('public_api_directory', { entries })).stored);
  },
  async sendLetter(invoiceId: string, delivery: 'economy' | 'priority', color: boolean): Promise<PostalLetter> {
    return letterFromRaw(record(await invoke('postal_send_invoice', { invoiceId, delivery, color })).letter);
  },
  async letters(documentId: string): Promise<PostalLetter[]> {
    const letters = record(await invoke('postal_letters', { documentId })).letters;
    return Array.isArray(letters) ? letters.map(letterFromRaw) : [];
  },
};

export type PosPaymentMethod = 'cash' | 'payrexx' | 'terminal';
export type PosTicketLine = Readonly<{
  id: string; ticketId: string; position: number; catalogItemId: string | null; description: string; quantityMilli: number; unit: string;
  unitPriceCents: number; discountBp: number; vatBp: number; netCents: number; vatCents: number; totalCents: number; stockMoved: boolean;
}>;
export type PosTicket = Readonly<{
  id: string; number: string; kind: 'sale' | 'void'; date: string; method: PosPaymentMethod; currency: string;
  subtotalCents: number; vatCents: number; totalCents: number; receivedCents: number | null; changeCents: number | null;
  reference: string | null; voidsTicketId: string | null; createdAt: string;
}>;
export type PosDay = Readonly<{
  date: string; tickets: PosTicket[]; lines: PosTicketLine[];
  totals: Readonly<{ cashCents: number; payrexxCents: number; terminalCents: number; totalCents: number; ticketCount: number }>;
  closing: Readonly<{ id: string; invoiceId: string | null; totalCents: number }> | null;
}>;

const nullableCount = (value: unknown) => (typeof value === 'number' ? value : null);

export function posTicketFromRaw(raw: unknown): PosTicket {
  const value = record(raw);
  return {
    id: text(value.id), number: text(value.number), kind: value.kind === 'void' ? 'void' : 'sale', date: text(value.ticket_date),
    method: value.payment_method === 'payrexx' || value.payment_method === 'terminal' ? value.payment_method : 'cash',
    currency: text(value.currency) || 'CHF', subtotalCents: count(value.subtotal_cents), vatCents: count(value.vat_cents), totalCents: count(value.total_cents),
    receivedCents: nullableCount(value.received_cents), changeCents: nullableCount(value.change_cents), reference: text(value.payment_reference) || null,
    voidsTicketId: text(value.voids_ticket_id) || null, createdAt: text(value.created_at),
  };
}

export function posLineFromRaw(raw: unknown): PosTicketLine {
  const value = record(raw);
  return {
    id: text(value.id), ticketId: text(value.ticket_id), position: count(value.position), catalogItemId: text(value.catalog_item_id) || null,
    description: text(value.description), quantityMilli: count(value.quantity_milli), unit: text(value.unit), unitPriceCents: count(value.unit_price_cents),
    discountBp: count(value.discount_bp), vatBp: count(value.vat_bp), netCents: count(value.line_net_cents), vatCents: count(value.line_vat_cents),
    totalCents: count(value.line_total_cents), stockMoved: value.stock_moved === 1 || value.stock_moved === true,
  };
}

export function posDayFromRaw(raw: unknown): PosDay {
  const value = record(raw), totals = record(value.totals), closing = record(value.closing);
  return {
    date: text(value.date),
    tickets: Array.isArray(value.tickets) ? value.tickets.map(posTicketFromRaw) : [],
    lines: Array.isArray(value.lines) ? value.lines.map(posLineFromRaw) : [],
    totals: { cashCents: count(totals.cash_cents), payrexxCents: count(totals.payrexx_cents), terminalCents: count(totals.terminal_cents), totalCents: count(totals.total_cents), ticketCount: count(totals.ticket_count) },
    closing: closing.id ? { id: text(closing.id), invoiceId: text(closing.invoice_id) || null, totalCents: count(closing.total_cents) } : null,
  };
}

export type PosLineInput = Readonly<{ catalogItemId: string | null; description: string; quantityMilli: number; unit: string; unitPriceCents: number; discountBp: number; vatBp: number }>;

export const posApi = {
  async day(date: string): Promise<PosDay> {
    return posDayFromRaw(await invoke('pos_day', { date }));
  },
  async record(input: Readonly<{ requestId: string; date: string; method: PosPaymentMethod; currency: string; receivedCents: number | null; reference: string | null; lines: readonly PosLineInput[] }>) {
    const raw = record(await invoke('record_pos_ticket', { input: {
      request_id: input.requestId, ticket_date: input.date, payment_method: input.method, currency: input.currency,
      received_cents: input.receivedCents, payment_reference: input.reference, note: null,
      lines: input.lines.map((line) => ({ catalog_item_id: line.catalogItemId, description: line.description, quantity_milli: line.quantityMilli, unit: line.unit, unit_price_cents: line.unitPriceCents, discount_bp: line.discountBp, vat_bp: line.vatBp })),
    } }));
    return {
      ticket: posTicketFromRaw(raw),
      lines: Array.isArray(raw.lines) ? raw.lines.map(posLineFromRaw) : [],
      shortfalls: Array.isArray(raw.stock_shortfalls) ? raw.stock_shortfalls.map(text) : [],
    };
  },
  async voidTicket(requestId: string, ticketId: string, reason?: string) {
    return posTicketFromRaw(await invoke('void_pos_ticket', { input: { request_id: requestId, ticket_id: ticketId, reason: reason || null } }));
  },
  async close(date: string, invoiceId: string | null) {
    await invoke('record_pos_closing', { date, invoiceId });
  },
  async createGateway(amountCents: number, currency: string): Promise<{ reference: string; url: string }> {
    const raw = record(await invoke('create_pos_payment_gateway', { amountCents, currency }));
    return { reference: text(raw.reference), url: text(raw.url) };
  },
  async gatewayStatus(reference: string): Promise<'open' | 'paid' | 'failed' | 'cancelled'> {
    const status = record(await invoke('pos_payment_status', { reference })).status;
    return status === 'paid' || status === 'failed' || status === 'cancelled' ? status : 'open';
  },
};
