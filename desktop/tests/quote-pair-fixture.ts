// Synthetic UI fixture; persistence, money, issuing and migrations are tested in Rust.
import { desktopApi } from '../src/bridge';
import { buildDepositLines } from '../src/deposit';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import { documentTotals } from '../src/utils';
import type { Invoice, Project, Quote, Workspace } from '../src/types';

export function installQuotePairFixture(data: Workspace) {
  desktopApi.loadWorkspace = async () => {
    if (sessionStorage.getItem('qa-pair-block-reads') === '1') throw Error('Lecture du dossier momentanément indisponible.');
    return structuredClone(data);
  };
  const afterWrite = (kind: string) => {
    const events = JSON.parse(sessionStorage.getItem('qa-pair-writes') || '[]'); events.push(kind);
    sessionStorage.setItem('qa-pair-writes', JSON.stringify(events));
    sessionStorage.setItem('qa-pair-snapshot', JSON.stringify(data));
    if (sessionStorage.getItem('qa-pair-recover') === kind) sessionStorage.setItem('qa-pair-block-reads', '1');
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
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
  desktopApi.convertQuote = async (_, bp) => { data.invoices = [depositFor(bp ?? 10000)]; complete(); return afterWrite('convert'); };
  desktopApi.createQuoteBalance = async () => { complete(); return afterWrite('balance'); };
  desktopApi.updateEntity = async (entity, id, patch) => {
    if (entity !== 'invoices') throw new Error('Unexpected fixture mutation');
    if (sessionStorage.getItem('qa-pair-refuse-update') === '1') throw Error('Les dates n’ont pas pu être enregistrées. Réessayez.');
    Object.assign(data.invoices.find((invoice) => invoice.id === id)!, patch);
    return afterWrite('update');
  };
  desktopApi.issueDocument = async (entity, id) => {
    if (entity !== 'invoices') throw new Error('Unexpected fixture issue');
    if (sessionStorage.getItem('qa-pair-refuse-issue') === '1') throw Error('La période de facturation est fermée. Vérifiez la date d’émission.');
    if (sessionStorage.getItem('qa-pair-hold-issue') === '1') await new Promise(resolve => window.addEventListener('qa-release-pair-issue', resolve, { once: true }));
    const invoice = data.invoices.find((invoice) => invoice.id === id)!;
    if (!invoice.serviceDateFrom) throw new Error('Complétez les dates de prestation.');
    invoice.status = 'issued'; invoice.number = invoice.type === 'deposit' ? 'F-2026-0042' : 'F-2026-0043';
    // Synthetic issued-invoice snapshot with a credit allocated from another dossier.
    if (invoice.id === pair.balanceInvoiceId && new URLSearchParams(location.search).has('folderCredit')) invoice.creditedCents = 20000;
    return afterWrite('issue');
  };
  const accountingSettings = desktopApi.getAccountingSettings;
  desktopApi.getAccountingSettings = async () => ({ ...await accountingSettings(), enabled: true });
  desktopApi.addPayment = async (id, input) => {
    if (sessionStorage.getItem('qa-pair-refuse-payment') === '1') throw Error('Le paiement n’a pas été enregistré. Réessayez.');
    if (data.payments.some(payment => payment.id === input.requestId)) throw Error('Duplicate payment attempt');
    const invoice = data.invoices.find(invoice => invoice.id === id)!;
    data.payments.push({ ...input, id: input.requestId, invoiceId: id });
    invoice.paidCents = data.payments.filter(payment => payment.invoiceId === id).reduce((sum, payment) => sum + payment.amountCents, 0);
    invoice.status = invoice.paidCents + (invoice.creditedCents ?? 0) === documentTotals(invoice.lines).totalCents ? 'paid' : 'partially_paid';
    return afterWrite('payment');
  };
  if (new URLSearchParams(location.search).has('legacyPair')) data.invoices = [depositFor(3000)];
}
