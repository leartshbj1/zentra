/**
 * Articles the person linked to the lines of a request in review. Autopilote
 * remembers the wording on the server for future requests; this device keeps
 * the link for the request at hand so it is still shown after leaving the
 * screen, and so "Créer le devis" can include those lines.
 */
export type AutopilotLineLink = Readonly<{ articleId: string; name: string; term: string }>;
type Store = Record<string, Record<string, Record<string, AutopilotLineLink>>>;

const KEY = 'zentra.autopilot.line-links.v1';
const MAX_PROPOSALS = 200;

function read(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value = raw ? JSON.parse(raw) as unknown : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Store : {};
  } catch { return {}; }
}
function write(store: Store) {
  try { window.localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* best effort */ }
}
const valid = (link: unknown): link is AutopilotLineLink => !!link && typeof link === 'object'
  && typeof (link as AutopilotLineLink).articleId === 'string' && typeof (link as AutopilotLineLink).name === 'string'
  && typeof (link as AutopilotLineLink).term === 'string';

export function autopilotLineLinks(organizationId: string, proposalId: string): Readonly<Record<string, AutopilotLineLink>> {
  const links = read()[organizationId]?.[proposalId];
  if (!links || typeof links !== 'object') return {};
  return Object.fromEntries(Object.entries(links).filter(([, link]) => valid(link)));
}

export function saveAutopilotLineLink(organizationId: string, proposalId: string, phrase: string, link: AutopilotLineLink | null) {
  const store = read();
  const company = { ...(store[organizationId] ?? {}) };
  const lines = { ...(company[proposalId] ?? {}) };
  if (link) lines[phrase] = link; else delete lines[phrase];
  if (Object.keys(lines).length) company[proposalId] = lines; else delete company[proposalId];
  // Keep the most recent requests only.
  const proposals = Object.keys(company);
  for (const old of proposals.slice(0, Math.max(0, proposals.length - MAX_PROPOSALS))) delete company[old];
  store[organizationId] = company;
  write(store);
}

/** The quantity written at the start or end of a request line ("2 licences", "licences x3"), else 1. */
export function phraseQuantity(phrase: string): number {
  const match = /^\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:x|×|\*)?\s+\S/i.exec(phrase)
    ?? /\S\s+(?:x|×|\*)\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*$/i.exec(phrase);
  const value = match ? Number(match[1].replace(',', '.')) : 1;
  return Number.isFinite(value) && value > 0 && value <= 10_000 ? value : 1;
}
