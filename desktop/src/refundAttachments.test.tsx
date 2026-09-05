import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
import { ExpenseRefundHistory } from './ExpenseRefundForm';
import { ProjectFolder } from './ProjectFolder';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
import type { Attachment, Expense, ExpenseRefund, Workspace } from './types';

const refund = { id: 'refund', expenseId: 'expense', reference: 'AV-001', eventType: 'refund', totalCents: 5405, creditDate: '2026-04-20', paymentDate: '2026-07-05', reason: 'Retour de marchandises' } as ExpenseRefund;
const file = { id: 'file', entityType: 'expense_refund', entityId: refund.id, projectId: 'project', originalName: 'avoir.pdf', mimeType: 'application/pdf', sizeBytes: 100, createdAt: '2026-09-05' } as Attachment;
afterEach(() => { vi.unstubAllGlobals(); invokeMock.mockReset(); });

function fileReader() {
  vi.stubGlobal('FileReader', class {
    result = ''; onload = () => {}; onerror = () => {};
    async readAsDataURL(blob: Blob) { this.result = `data:application/pdf;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`; this.onload(); }
  });
}
describe('justificatifs des remboursements', () => {
  it('transmet les octets du fichier dans la commande atomique sans changer le contrat financier', async () => {
    fileReader();
    invokeMock.mockImplementation(async command => command === 'get_app_state' ? { onboarding_completed: false } : {});
    await desktopApi.recordExpenseRefund({ ...refund, requestId: 'request', netCents: 5000, vatCents: 405, receipt: new File(['%PDF-avoir'], 'avoir.pdf') });
    expect(invokeMock).toHaveBeenCalledWith('record_expense_refund', expect.objectContaining({ input: expect.objectContaining({ request_id: 'request', expense_id: 'expense', net_cents: 5000 }), attachment: { original_name: 'avoir.pdf', content_base64: Buffer.from('%PDF-avoir').toString('base64') } }));
  });
  it('ajoute au bon événement et distingue la lecture interrompue du refus de copie', async () => {
    fileReader();
    invokeMock.mockImplementation(async command => { if (command === 'get_app_state') throw new Error('Lecture interrompue'); return {}; });
    await expect(desktopApi.addExpenseRefundAttachment('refund', new File(['%PDF-avoir'], 'avoir.pdf'))).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'add_expense_refund_attachment')).toEqual([['add_expense_refund_attachment', { refundId: 'refund', attachment: { original_name: 'avoir.pdf', content_base64: Buffer.from('%PDF-avoir').toString('base64') } }]]);
    invokeMock.mockReset();
    const denied = new Error('Copie impossible'); invokeMock.mockRejectedValue(denied);
    await expect(desktopApi.addExpenseRefundAttachment('refund', new File(['%PDF-avoir'], 'avoir.pdf'))).rejects.toBe(denied);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
  it('garde les pièces des remboursements corrigés consultables en lecture seule et masque les autres événements', () => {
    const expense = { refunds: [refund, { ...refund, id: 'correction', eventType: 'reverse', reversesId: refund.id }] } as Expense;
    const html = renderToStaticMarkup(<ExpenseRefundHistory expense={expense} attachments={[file, { ...file, id: 'foreign', entityId: 'other', originalName: 'autre.pdf' }]} disabled onReverse={vi.fn()} onAttach={vi.fn()} />);
    expect(html).toContain('Remboursement corrigé'); expect(html).toContain('Ouvrir avoir.pdf'); expect(html).not.toContain('autre.pdf');
    expect(html).toMatch(/disabled=""[^>]*>Joindre un justificatif/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Ouvrir avoir.pdf"/);
  });
  it('classe le fichier dans le projet avec un accès à la dépense et conserve son caractère non supprimable', () => {
    const project = { id: 'project', name: 'Projet test', clientId: 'client', status: 'in_progress' } as Workspace['projects'][number];
    const workspace = { attachments: [file], expenses: [{ id: 'expense', refunds: [refund] }], clients: [], quotes: [], invoices: [], salesOrders: [], supplierInvoices: [] } as unknown as Workspace;
    const html = renderToStaticMarkup(<ProjectFolder project={project} workspace={workspace} busy={false} readOnly onBack={vi.fn()} onOpenDocument={vi.fn()} onCreateDocument={vi.fn()} onWorkspaceChange={vi.fn()} onOpenExpense={vi.fn()} />);
    expect(html).toContain('Avoir / remboursement de dépense'); expect(html).toContain('Voir la dépense liée à avoir.pdf'); expect(html).not.toContain('Supprimer avoir.pdf');
  });
});
