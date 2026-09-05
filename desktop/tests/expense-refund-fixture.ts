// Browser-only simulated persistence; native SQLite tests verify the actual journals and VAT.
import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import type { ExpenseRefund, Workspace } from '../src/types';
import { installProjectCostFixture } from './project-cost-fixture';
import { installRefundAttachmentFixture } from './refund-attachment-fixture';

export function installExpenseRefundFixture(initial: Workspace) {
  installProjectCostFixture(initial);
  initial.schemaVersion = 49;
  initial.projects = [initial.projects[0]];
  initial.expenses = [{ ...initial.expenses[0], id: 'expense-refund-qa', costCents: 10000, refunds: [] }];
  initial.invoices = []; initial.supplierInvoices = []; initial.supplierCreditNotes = [];
  initial.accountingSettings = { enabled: true, arAccountId: 'ar', revenueAccountId: 'revenue', vatPayableAccountId: 'vat-out', vatDeferredPayableAccountId: 'vat-deferred', bankAccountId: 'bank', expenseAccountId: 'expense', vatReceivableAccountId: 'vat-in', wagesExpenseAccountId: 'wages', wagesPayableAccountId: 'wages-payable', socialExpenseAccountId: 'social', socialPayableAccountId: 'social-payable', supplierPayableAccountId: 'ap' };
  desktopApi.getAccountingSettings = async () => structuredClone(initial.accountingSettings!);
  const persisted = structuredClone(initial);
  const requests = new Map<string, string>();
  let commits = 0;
  let readFailures = 0;
  desktopApi.loadWorkspace = async () => { if (readFailures > 0) { readFailures -= 1; throw new Error('Lecture interrompue après enregistrement'); } return structuredClone(persisted); };
  const attach = installRefundAttachmentFixture(persisted);
  desktopApi.recordExpenseRefund = async (input) => {
    const attempts = JSON.parse(sessionStorage.getItem('qa-refund-attempts') || '[]');
    sessionStorage.setItem('qa-refund-attempts', JSON.stringify([...attempts, input]));
    if (sessionStorage.getItem('qa-refund-deny') === '1') { sessionStorage.removeItem('qa-refund-deny'); throw new Error('La période comptable est clôturée. Choisissez une date ouverte.'); }
    const previous = requests.get(input.requestId);
    if (previous && previous !== JSON.stringify(input)) throw new Error('Cette tentative a déjà été enregistrée avec d’autres données.');
    if (!previous) {
      const refund: ExpenseRefund = { ...input, id: `refund-${++commits}`, eventType: input.reversesId ? 'reverse' : 'refund', totalCents: input.netCents + input.vatCents, costCents: input.netCents, treatment: 'input_materials', creditJournalId: `credit-${commits}`, paymentJournalId: `payment-${commits}`, createdAt: '2026-09-05T12:00:00Z' };
      persisted.expenses[0].refunds!.push(refund);
      if (input.receipt) await attach(refund.id, input.receipt);
      requests.set(input.requestId, JSON.stringify(input));
      sessionStorage.setItem('qa-refund-commits', String(commits));
      if (!input.reversesId) throw new Error('Réponse perdue après enregistrement. Réessayez cette même saisie pour retrouver le résultat.');
    } else if (!input.reversesId) readFailures = 2;
    return refreshWorkspaceAfterMutation(desktopApi.loadWorkspace);
  };
}
