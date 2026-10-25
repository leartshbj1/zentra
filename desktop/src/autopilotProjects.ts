import type { Client, Project, Quote } from './types';
import { documentTotals } from './utils';

/**
 * Accepted quote → job site ("chantier"): Autopilote proposes the project with the
 * client, the address, a budget taken from the quote and one task per quote line.
 * Amounts come from the app's own totals; the person creates it with one click.
 */
const HOUR_UNITS = /^(?:h|hr|hrs|heure|heures|hour|hours|std|stunde|stunden|ora|ore)\.?$/iu;
const DAYS = 60;

export function projectKey(quoteId: string) { return 'chantier:' + quoteId; }

/** Accepted quotes of the last 60 days that no project carries yet (linked or named in its notes). */
export function quotesToStartProject(quotes: readonly Quote[], projects: readonly Project[], today: string): Quote[] {
  const since = new Date(Date.parse(today + 'T12:00:00Z') - DAYS * 86_400_000).toISOString().slice(0, 10);
  return quotes.filter(quote => quote.status === 'accepted' && !quote.projectId && quote.number
    && (quote.issueDate || quote.createdAt.slice(0, 10)) >= since
    && !projects.some(project => !project.archivedAt && project.notes.includes(quote.number)))
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate));
}

/** The project to create from the quote, ready for `saveProject`, with its tasks. */
export function projectFromQuote(quote: Quote, client: Client | undefined, today: string, noteTemplate = 'Repris du devis {number}.') {
  const clientName = client?.company || client?.name || '';
  const title = quote.title.replace(/^\s*(?:devis|offerte|angebot|preventivo|quote)\s*[–:-]\s*/iu, '').trim();
  const plannedMinutes = Math.round(quote.lines.filter(line => HOUR_UNITS.test(line.unit.trim()))
    .reduce((sum, line) => sum + Math.max(0, line.quantity) * 60, 0));
  const data = {
    clientId: quote.clientId, code: '', name: (title || clientName || quote.number).slice(0, 160),
    addressLine1: client?.addressLine1 || client?.address || '', addressLine2: client?.addressLine2 || '',
    postalCode: client?.postalCode || '', city: client?.city || '', canton: client?.canton || '',
    status: 'planned', plannedStartDate: today, plannedEndDate: '', actualStartDate: '', actualEndDate: '',
    budgetCents: documentTotals(quote.lines).netCents, plannedMinutes, description: '',
    notes: noteTemplate.replace('{number}', quote.number),
  };
  const tasks = quote.lines.filter(line => line.description.trim()).slice(0, 40)
    .map((line, index) => ({ title: line.description.trim().split('\n')[0].slice(0, 200), sortOrder: index + 1 }));
  return { data, tasks };
}
