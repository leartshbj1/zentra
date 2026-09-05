// Synthetic UI fixture; persistence, money, issuing and migrations are tested in Rust.
import { desktopApi } from '../src/bridge';
import { buildDepositLines } from '../src/deposit';
import type { Invoice, Project, Quote, Workspace } from '../src/types';

export function installQuotePairFixture(data: Workspace) {
  const quote: Quote = { id: 'quote-pair', number: 'D-2026-0042', clientId: 'client-qa', projectId: 'project-pair', title: 'Installation et mise en service', issueDate: '2026-09-01', validUntil: '2026-10-01', currency: 'CHF', status: 'accepted', notes: '', terms: '', createdAt: '2026-09-01T08:00:00Z', lines: [{ id: 'source-line', catalogItemId: null, description: 'Installation et mise en service', quantity: 1, unit: 'forfait', unitPriceCents: 100000, discountBp: 0, vatRateBp: 810 }] };
  data.quotes = [quote];
  data.projects = [{ id: 'project-pair', clientId: quote.clientId, name: 'Projet de facturation', status: 'active', address: '', notes: '', plannedMinutes: 0, budgetCents: 0 } as Project];
  const pair = { depositInvoiceId: 'deposit-pair', balanceInvoiceId: 'balance-pair' };
  const depositFor = (bp: number): Invoice => ({ ...quote, id: pair.depositInvoiceId, quoteId: quote.id, number: '', type: 'deposit', status: 'draft', dueDate: '2026-10-01', serviceDateFrom: '', serviceDateTo: '', originalInvoiceId: null, depositPercentageBp: bp, depositBasisLines: quote.lines, lines: buildDepositLines(quote.lines, bp, (_, i) => `deposit-${i}`) });
  const complete = () => {
    const deposit = data.invoices[0];
    if (data.invoices.length > 1) return structuredClone(data);
    deposit.billingPair = pair;
    data.invoices.push({ ...deposit, id: pair.balanceInvoiceId, type: 'final', title: `Solde — ${quote.title}`, depositPercentageBp: null, depositBasisLines: null, lines: [...quote.lines.map((line) => ({ ...line, id: `balance-${line.id}` })), ...deposit.lines.map((line) => ({ ...line, id: `minus-${line.id}`, description: `Déduction — ${line.description}`, unitPriceCents: -line.unitPriceCents }))] });
    return structuredClone(data);
  };
  desktopApi.convertQuote = async (_, bp) => { data.invoices = [depositFor(bp ?? 10000)]; return complete(); };
  desktopApi.createQuoteBalance = async () => complete();
  desktopApi.updateEntity = async (entity, id, patch) => {
    if (entity !== 'invoices') throw new Error('Unexpected fixture mutation');
    Object.assign(data.invoices.find((invoice) => invoice.id === id)!, patch);
    return structuredClone(data);
  };
  desktopApi.issueDocument = async (entity, id) => {
    if (entity !== 'invoices') throw new Error('Unexpected fixture issue');
    const invoice = data.invoices.find((invoice) => invoice.id === id)!;
    if (!invoice.serviceDateFrom) throw new Error('Complétez les dates de prestation.');
    invoice.status = 'issued'; invoice.number = invoice.type === 'deposit' ? 'F-2026-0042' : 'F-2026-0043';
    return structuredClone(data);
  };
  if (new URLSearchParams(location.search).has('legacyPair')) data.invoices = [depositFor(3000)];
}
