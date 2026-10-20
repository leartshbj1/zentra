// Journal local des actions validées depuis Autopilote, avec l'annulation
// quand l'app connaît l'opération inverse, et les règles apprises après
// trois validations identiques. Rien ne s'exécute sans clic, même avec une
// règle apprise : elle regroupe seulement les cartes à valider.

export type UndoSpec =
  | Readonly<{ kind: 'follow-up'; key: string; previous: Readonly<{ until?: string; ignored?: true; sentCount?: number; lastSentAt?: string }> | null }>
  | Readonly<{ kind: 'supplier-draft'; invoiceId: string }>
  | Readonly<{ kind: 'record-fields'; entity: 'clients' | 'suppliers'; id: string; fields: Readonly<Record<string, string>> }>
  | Readonly<{ kind: 'quote-status'; quoteId: string; status: string }>;

export type JournalEntry = Readonly<{
  id: string;
  at: string;
  key: string;
  actionLabel: string;
  title: string;
  detail: string;
  /** null : simple ouverture d'un écran ; false : l'action n'a pas abouti. */
  ok: boolean | null;
  /** Signature d'une règle apprenable (même fournisseur, même catégorie…). */
  signature?: string;
  undo?: UndoSpec;
  undoneAt?: string;
  /** Set when an opened form was later confirmed by the data (the payment exists). */
  confirmedAt?: string;
}>;

const JOURNAL_KEY = 'zentra.autopilot.journal.v1';
const RULES_KEY = 'zentra.autopilot.rules.v1';
const MAX_ENTRIES = 500;

function read<T>(key: string, organizationId: string, fallback: T): T {
  try {
    const all = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, T>;
    return all[organizationId] ?? fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, organizationId: string, value: T): void {
  try {
    const all = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, T>;
    all[organizationId] = value;
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // Journal de cet appareil seulement : les opérations restent dans l'audit natif.
  }
}

export function journalEntries(organizationId: string): JournalEntry[] {
  const entries = read<JournalEntry[]>(JOURNAL_KEY, organizationId, []);
  return Array.isArray(entries) ? entries : [];
}

export function appendJournal(organizationId: string, entry: Omit<JournalEntry, 'id' | 'at'>, now = new Date()): JournalEntry {
  const full: JournalEntry = { ...entry, id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: now.toISOString() };
  write(JOURNAL_KEY, organizationId, [full, ...journalEntries(organizationId)].slice(0, MAX_ENTRIES));
  return full;
}

export function markUndone(organizationId: string, id: string, now = new Date()): void {
  write(JOURNAL_KEY, organizationId, journalEntries(organizationId).map((entry) => entry.id === id ? { ...entry, undoneAt: now.toISOString() } : entry));
}

/** Opened forms that the data now shows as completed become done (ok: true). */
export function confirmEntries(organizationId: string, ids: readonly string[], now = new Date()): void {
  if (!ids.length) return;
  const wanted = new Set(ids);
  write(JOURNAL_KEY, organizationId, journalEntries(organizationId).map((entry) =>
    wanted.has(entry.id) && entry.ok === null && !entry.undoneAt ? { ...entry, ok: true, confirmedAt: now.toISOString() } : entry));
}

/** When the action really took effect: the click, or the later confirmation of an opened form. */
export function doneAt(entry: JournalEntry): string {
  return entry.confirmedAt ?? entry.at;
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * What Autopilote really did today on this device, newest first: an action
 * that succeeded (ok: true), not undone since. Opened screens (ok: null) and
 * failures never count, so "Fait" only appears once the work exists.
 */
export function doneToday(entries: readonly JournalEntry[], now = new Date()): JournalEntry[] {
  const today = localDay(now);
  return entries
    // "Ignorer" and "Reporter" are decisions, not work done: they stay in the journal only.
    .filter((entry) => entry.ok === true && !entry.undoneAt && entry.undo?.kind !== 'follow-up' && localDay(new Date(doneAt(entry))) === today)
    .sort((a, b) => doneAt(b).localeCompare(doneAt(a)));
}

/** Opened forms (ok: null) of the last 7 days that the data now shows as completed. */
export function entriesToConfirm(entries: readonly JournalEntry[], completed: (entry: JournalEntry) => boolean, now = new Date()): string[] {
  const since = now.getTime() - 7 * 86_400_000;
  return entries.filter((entry) => entry.ok === null && !entry.undoneAt && Date.parse(entry.at) >= since && completed(entry)).map((entry) => entry.id);
}

export function canUndo(entry: JournalEntry): boolean {
  return entry.ok === true && Boolean(entry.undo) && !entry.undoneAt;
}

/** Signatures validées au moins trois fois, sans règle déjà acceptée ni refusée. */
export function ruleProposals(entries: readonly JournalEntry[], decided: ReadonlySet<string>, threshold = 3): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.ok !== true || entry.undoneAt || !entry.signature) continue;
    counts.set(entry.signature, (counts.get(entry.signature) ?? 0) + 1);
  }
  return [...counts].filter(([signature, count]) => count >= threshold && !decided.has(signature)).map(([signature]) => signature).sort();
}

export type LearnedRules = Readonly<Record<string, 'always' | 'never'>>;

export function learnedRules(organizationId: string): LearnedRules {
  const rules = read<LearnedRules>(RULES_KEY, organizationId, {});
  return rules && typeof rules === 'object' ? rules : {};
}

export function decideRule(organizationId: string, signature: string, decision: 'always' | 'never'): void {
  write(RULES_KEY, organizationId, { ...learnedRules(organizationId), [signature]: decision });
}

/** « supplier:Swisscom (Schweiz) AG » → libellé lisible pour la carte de règle. */
export function signatureLabel(signature: string): string {
  return signature.slice(signature.indexOf(':') + 1);
}
