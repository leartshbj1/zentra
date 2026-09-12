import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import { documentTotals } from '../src/utils';
import type { Invoice, Quote, Workspace } from '../src/types';

// Synthetic native acknowledgements. Bridge tests separately exercise actual RPC boundaries.
export function installSalesRecoveryFixture(data: Workspace) {
  const quote: Quote = { id: 'ecf3fc46-9b8b-4a5e-b1d7-b72b518cae9e', number: 'D-2026-0001', title: 'Devis original', clientId: 'client-qa', projectId: null, status: 'issued', issueDate: '2026-09-01', validUntil: '2026-09-30', currency: 'CHF', notes: 'Original conservé', terms: '', createdAt: '2026-09-01T09:00:00Z', lines: [{ id: 'original-line', description: 'Prestation', quantity: 1, unit: 'forfait', unitPriceCents: 100000, discountBp: 0, vatRateBp: 810 }] };
  const invoice: Invoice = { ...quote, id: '7393bc90-ae53-4c51-a9ba-a1c84f145bf0', number: 'F-2026-0001', title: 'Facture originale', type: 'final', quoteId: null, originalInvoiceId: null, dueDate: '2026-09-30', serviceDateFrom: '2026-09-01', serviceDateTo: '', depositPercentageBp: null, depositBasisLines: null, paidCents: 0 };
  data.quotes = [quote]; data.invoices = [invoice]; data.payments = []; data.invoiceCorrectionWorkflows = [];
  const track = (kind: string, input: unknown) => {
    const rows = JSON.parse(sessionStorage.getItem('qa-sales-writes') || '[]'); rows.push({ kind, input });
    sessionStorage.setItem('qa-sales-writes', JSON.stringify(rows));
  };
  function commit(kind: string, input: unknown) {
    track(kind, input);
    sessionStorage.setItem('qa-sales-snapshot', JSON.stringify(data));
    if (sessionStorage.getItem('qa-sales-recover') === kind) sessionStorage.setItem('qa-sales-block-reads', '1');
  }
  desktopApi.loadWorkspace = async () => {
    if (sessionStorage.getItem('qa-sales-block-reads') === '1') throw Error('Lecture locale momentanément indisponible.');
    return structuredClone(data);
  };
  const settings = desktopApi.getAccountingSettings;
  desktopApi.getAccountingSettings = async () => {
    if (sessionStorage.getItem('qa-sales-accounting-unavailable') === '1') throw Error('Lecture comptable interrompue');
    return { ...await settings(), enabled: true };
  };
  desktopApi.saveDocument = async (entity, input, lines, existing) => {
    if (sessionStorage.getItem('qa-sales-refuse-save') === '1') throw Error('Enregistrement indisponible. Vos modifications sont conservées.');
    const id = existing?.id || crypto.randomUUID();
    const document = { ...input, id, lines, status: 'draft', number: '', createdAt: existing?.createdAt || new Date().toISOString() };
    data[entity] = [...data[entity].filter(item => item.id !== id), document] as never;
    commit('save', { entity, id, input, lines });
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
  desktopApi.createQuoteRevision = async (requestId, id) => {
    const original = data.quotes.find(item => item.id === id)!;
    const revision = { ...original, id: crypto.randomUUID(), status: 'draft' as const, number: '', title: 'Devis à modifier' };
    data.quotes.push(revision); commit('revision', { requestId, id, revisionId: revision.id });
    return { revisionId: revision.id };
  };
  desktopApi.createInvoiceCorrection = async (id, reason) => {
    if (sessionStorage.getItem('qa-sales-refuse-correction') === '1') throw Error('La correction est momentanément indisponible. Réessayez.');
    const original = data.invoices.find(item => item.id === id)!;
    const credit: Invoice = { ...original, id: crypto.randomUUID(), type: 'credit_note', status: 'draft', number: '', originalInvoiceId: id, title: 'Avoir de correction', lines: original.lines.map(line => ({ ...line, id: crypto.randomUUID(), unitPriceCents: -line.unitPriceCents })) };
    const replacement: Invoice = { ...original, id: crypto.randomUUID(), status: 'draft', number: '', title: 'Facture à modifier' };
    data.invoices.push(credit, replacement);
    const workflow = { id: crypto.randomUUID(), originalInvoiceId: id, creditNoteId: credit.id, replacementInvoiceId: replacement.id, reason, createdAt: new Date().toISOString() };
    data.invoiceCorrectionWorkflows.push(workflow); commit('correction', workflow);
    return { workflowId: workflow.id, creditNoteId: credit.id, replacementInvoiceId: replacement.id };
  };
  desktopApi.addPayment = async (id, input) => {
    if (sessionStorage.getItem('qa-sales-refuse-payment') === '1') throw Error('La période comptable est fermée. Choisissez une date dans une période ouverte.');
    const item = data.invoices.find(item => item.id === id)!;
    data.payments.push({ ...input, id: input.requestId, invoiceId: id });
    item.paidCents = data.payments.filter(payment => payment.invoiceId === id).reduce((sum, payment) => sum + payment.amountCents, 0);
    item.status = item.paidCents === documentTotals(item.lines).totalCents ? 'paid' : 'partially_paid';
    commit('payment', input);
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
}
