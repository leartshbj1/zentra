import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, Expense, ExpenseRefund, Invoice, Project, SupplierInvoice, Workspace } from './types';

// Real React SSR, source handlers and bridge; only the native transport is
// synthetic. Effects, DOM admission and native scope enforcement are not tested.
const runtime = vi.hoisted(() => ({
  invoke: vi.fn(), clicks: [] as any[], previews: [] as any[], documents: false,
}));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: runtime.invoke }));
vi.mock('react/jsx-runtime', async importOriginal => {
  const original = await importOriginal<typeof import('react/jsx-runtime')>();
  const capture = (make: typeof original.jsx) => (...args: Parameters<typeof original.jsx>) => {
    const element = make(...args);
    if (element.type === 'button' && typeof (element.props as any).onClick === 'function') runtime.clicks.push(element.props);
    return element;
  };
  return { ...original, jsx: capture(original.jsx), jsxs: capture(original.jsxs) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const original = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...original, jsxDEV: (...args: Parameters<typeof original.jsxDEV>) => {
    const element = original.jsxDEV(...args);
    if (element.type === 'button' && typeof (element.props as any).onClick === 'function') runtime.clicks.push(element.props);
    return element;
  } };
});
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  return { ...original, useState: (initial: any) => {
    // Enter the real supplier-credit list without running navigation effects.
    const [value, setValue] = original.useState(runtime.documents && initial === 'inbox' ? 'documents' : initial);
    return [value, (next: any) => {
      if (next && typeof next === 'object' && 'file' in next && 'bytes' in next && 'url' in next) runtime.previews.push(next);
      setValue(next);
    }];
  } };
});

import { desktopApi } from './bridge';
import { SupplierInvoiceAttachments } from './SupplierInvoiceAttachments';
import { SupplierInvoiceDetail } from './SupplierInvoiceDetail';
import { RefundAttachmentList } from './RefundAttachments';
import { ExpenseRefundHistory } from './ExpenseRefundForm';
import { LegacyExpenseDetail } from './PurchasesScreen';
import { CustomerCreditPanel } from './CustomerCreditPanel';
import { PurchaseOrdersScreen } from './PurchaseOrdersScreen';
import { ProjectFilePreview } from './ProjectFilePreview';
import { ProjectFolder } from './ProjectFolder';
import { isMobileRuntime } from './mobileRuntime';

const origin = 'synthetic-workspace-a', replacement = 'synthetic-workspace-b';
const file = { id: 'file-a', projectId: 'project-a', entityType: 'supplier_invoice', entityId: 'invoice-a', originalName: 'SYNTHETIC.pdf', mimeType: 'application/pdf', sizeBytes: 20, createdAt: '2026-10-02', updatedAt: '2026-10-02' } as Attachment;
const invoice = { id: 'invoice-a', documentStatus: 'draft', reference: 'SYNTHETIC', attachments: [file], payments: [], lines: [], totalCents: 100, paidCents: 0, creditedCents: 0, balanceCents: 100, dueDate: '2026-10-02' } as unknown as SupplierInvoice;
const refund = { id: 'refund-a', reference: 'SYNTHETIC', eventType: 'refund', totalCents: 100, creditDate: '2026-10-02', paymentDate: '2026-10-02' } as ExpenseRefund;
const expense = { id: 'expense-a', totalCents: 100, netCents: 100, vatCents: 0, refunds: [refund] } as Expense;
const workspace = {
  workNotesScope: origin, onboardingCompleted: true,
  settings: { business: { nogaSection: 'F' }, organization: { legalName: 'Synthetic' } },
  attachments: [file], expenses: [], supplierInvoices: [invoice], supplierCreditNotes: [], projects: [],
  clients: [], invoices: [], quotes: [], salesOrders: [], suppliers: [], supplierOrders: [], supplierReceipts: [],
  supplierInvoiceMatches: [], catalogItems: [], accounts: [], bankAccounts: [],
} as unknown as Workspace;
function render(element: ReactElement) { runtime.clicks = []; return renderToStaticMarkup(element); }
function text(value: any): string {
  return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : typeof value === 'string' ? value : '';
}
function click(predicate: (props: any) => boolean) {
  const matches = runtime.clicks.filter(predicate); expect(matches).toHaveLength(1); return matches[0].onClick;
}
const settle = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };
const commandCalls = (command: string) => runtime.invoke.mock.calls.filter(([name]) => name === command);
const act = async (action: () => Promise<Workspace>) => { await action(); return true; };
beforeEach(() => {
  runtime.clicks = []; runtime.previews = []; runtime.documents = false;
  runtime.invoke.mockReset();
  runtime.invoke.mockImplementation(async command => command === 'get_app_state' ? { onboarding_completed: false } : command === 'read_project_document' ? 'U1lOVEhFVElD' : 'synthetic-opened');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('attachment origin scope reaches the real native bridge', () => {
  it.each([origin, undefined])('preserves scoped and legacy open/delete payloads, scope=%s', async scope => {
    expect(await desktopApi.openAttachment(file.id, scope)).toBe('synthetic-opened');
    await desktopApi.deleteSupplierInvoiceAttachment(file.id, scope);
    const expected = { id: file.id, ...(scope === undefined ? {} : { expectedWorkspaceScope: scope }) };
    expect(commandCalls('open_attachment')).toEqual([['open_attachment', expected]]);
    expect(commandCalls('delete_supplier_invoice_attachment')).toEqual([['delete_supplier_invoice_attachment', expected]]);
    expect(commandCalls('get_app_state')).toHaveLength(1);
  });

  it.each(['openAttachment', 'deleteSupplierInvoiceAttachment'] as const)('propagates the original %s refusal without a retry or workspace refresh', async method => {
    const reason = new Error('Synthetic scope refusal');
    runtime.invoke.mockRejectedValue(reason);
    await expect(desktopApi[method](file.id, origin)).rejects.toBe(reason);
    expect(runtime.invoke).toHaveBeenCalledTimes(1);
    expect(commandCalls('get_app_state')).toHaveLength(0);
  });

  it('keeps supplier open/delete tied to the rendered invoice after confirmation while act is held', async () => {
    let confirmedAction!: () => Promise<Workspace>, finish!: () => void;
    const heldAct = vi.fn((action: () => Promise<Workspace>) => { confirmedAction = action; return new Promise<boolean>(resolve => { finish = () => resolve(true); }); });
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    render(<SupplierInvoiceAttachments invoice={invoice} canEdit busy={false} workspaceScope={origin} act={heldAct} />);
    const open = click(props => text(props.children).trim() === 'Ouvrir');
    const remove = click(props => props['aria-label'] === `Supprimer ${file.originalName}`);
    open(); await settle(); remove();
    expect(commandCalls('delete_supplier_invoice_attachment')).toHaveLength(0);
    render(<SupplierInvoiceAttachments invoice={{ ...invoice, id: 'invoice-b' }} canEdit busy={false} workspaceScope={replacement} act={act} />);
    await confirmedAction(); finish(); await settle();
    expect(commandCalls('open_attachment')).toEqual([['open_attachment', { id: file.id, expectedWorkspaceScope: origin }]]);
    expect(commandCalls('delete_supplier_invoice_attachment')).toEqual([['delete_supplier_invoice_attachment', { id: file.id, expectedWorkspaceScope: origin }]]);
    expect(heldAct).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves cancellation and readonly delete guards, readonly=%s', async readonly => {
    vi.stubGlobal('window', { confirm: vi.fn(() => false) });
    const mutation = vi.fn(act);
    render(<SupplierInvoiceAttachments invoice={invoice} canEdit={!readonly} busy={false} workspaceScope={origin} act={mutation} />);
    if (!readonly) click(props => props['aria-label'] === `Supprimer ${file.originalName}`)();
    expect(commandCalls('delete_supplier_invoice_attachment')).toHaveLength(0); expect(mutation).not.toHaveBeenCalled();
  });

  it('passes the workspace through the real supplier detail', async () => {
    render(<SupplierInvoiceDetail invoice={invoice} workspace={workspace} busy={false} initialSection={1} close={vi.fn()} onPayment={vi.fn()} onReadWorkspace={async () => workspace} onOpenCredit={vi.fn()} />);
    click(props => text(props.children).trim() === 'Ouvrir')(); await settle();
    expect(commandCalls('open_attachment')).toEqual([['open_attachment', { id: file.id, expectedWorkspaceScope: origin }]]);
  });

  it('passes the workspace through legacy expense and its refund history', async () => {
    const expenseFile = { ...file, entityType: 'expense', entityId: expense.id };
    const refundFile = { ...file, id: 'refund-file', entityType: 'expense_refund', entityId: refund.id };
    render(<LegacyExpenseDetail expense={expense} workspace={{ ...workspace, expenses: [expense], attachments: [expenseFile, refundFile] }} busy={false} close={vi.fn()} act={act} />);
    click(props => text(props.children).trim() === 'Ouvrir' && !props['aria-label'])();
    click(props => props['aria-label'] === `Ouvrir ${file.originalName}`)(); await settle();
    expect(commandCalls('open_attachment')).toEqual([
      ['open_attachment', { id: file.id, expectedWorkspaceScope: origin }],
      ['open_attachment', { id: refundFile.id, expectedWorkspaceScope: origin }],
    ]);
  });

  it('retains omitted scope for a legacy refund-history caller', async () => {
    render(<ExpenseRefundHistory expense={expense} disabled onReverse={vi.fn()} attachments={[{ ...file, entityType: 'expense_refund', entityId: refund.id }]} />);
    click(props => props['aria-label'] === `Ouvrir ${file.originalName}`)(); await settle();
    expect(commandCalls('open_attachment')).toEqual([['open_attachment', { id: file.id }]]);
  });

  it('passes the workspace through the real customer credit event history', async () => {
    const credit = { id: 'credit-a', type: 'credit_note', status: 'sent', customerCredit: { remainingCents: 0 }, creditSettlements: [{ id: 'event-a', eventType: 'refund', date: '2026-10-02', amountCents: 100 }] } as unknown as Invoice;
    render(<CustomerCreditPanel invoice={credit} workspace={{ ...workspace, invoices: [credit], attachments: [{ ...file, entityType: 'customer_credit_settlement', entityId: 'event-a' }] }} busy={false} readOnly act={act} onReadWorkspace={async () => workspace} onOpenHelp={vi.fn()} />);
    click(props => props['aria-label'] === `Ouvrir ${file.originalName}`)(); await settle();
    expect(commandCalls('open_attachment')).toEqual([['open_attachment', { id: file.id, expectedWorkspaceScope: origin }]]);
  });

  it('passes the workspace through the real supplier credit refund list', async () => {
    runtime.documents = true;
    const credit = { id: 'credit-a', status: 'validated', documentDate: '2026-10-02', currency: 'CHF', totalCents: 100, allocatedCents: 0, refundedCents: 100, allocations: [], lines: [], refunds: [{ id: refund.id, date: '2026-10-02', amountCents: 100, eventType: 'refund', reference: 'SYNTHETIC' }] };
    const props = { workspace: { ...workspace, supplierCreditNotes: [credit], attachments: [{ ...file, entityType: 'supplier_credit_refund', entityId: refund.id }] }, query: '', busy: false, readOnly: true, onQueryChange: vi.fn(), runAction: vi.fn(), onReadWorkspace: async () => workspace };
    render(<PurchaseOrdersScreen {...props as any} />);
    click(props => props['aria-label'] === `Ouvrir ${file.originalName}`)(); await settle();
    expect(commandCalls('open_attachment')).toEqual([['open_attachment', { id: file.id, expectedWorkspaceScope: origin }]]);
  });

  it('keeps the project preview packet origin after a deferred byte read and another rendered workspace', async () => {
    let resolveRead!: (value: string) => void;
    runtime.invoke.mockImplementation(command => command === 'read_project_document' ? new Promise(resolve => { resolveRead = resolve; }) : Promise.resolve('synthetic-opened'));
    const project = { id: file.projectId, name: 'Synthetic project', status: 'in_progress' } as Project;
    const props = { project, workspace, busy: false, readOnly: true, onBack: vi.fn(), onOpenDocument: vi.fn(), onCreateDocument: vi.fn(), onWorkspaceChange: vi.fn() };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic');
    render(<ProjectFolder {...props} />);
    click(props => props.className === 'project-document-list__open')({ currentTarget: null });
    render(<ProjectFolder {...props} workspace={{ ...workspace, workNotesScope: replacement }} />);
    resolveRead('U1lOVEhFVElD'); await settle();
    expect(runtime.previews).toHaveLength(1);
    const packet = runtime.previews[0];
    expect(packet.workspaceScope).toBe(origin);
    const openLabel = isMobileRuntime() ? 'Enregistrer ou partager' : 'Ouvrir avec une application';
    expect(render(<ProjectFilePreview {...packet} onClose={vi.fn()} />)).toContain(openLabel);
    click(props => text(props.children).trim() === openLabel)(); await settle();
    expect(commandCalls('read_project_document')).toEqual([['read_project_document', { id: file.id, expectedWorkspaceScope: origin }]]);
    expect(commandCalls('open_attachment')).toEqual([['open_attachment', { id: file.id, expectedWorkspaceScope: origin }]]);
  });

  it('keeps failed refund opening a single read with no automatic retry', async () => {
    runtime.invoke.mockRejectedValue(new Error('Synthetic denied scope'));
    render(<RefundAttachmentList attachments={[file]} workspaceScope={origin} />);
    click(props => props['aria-label'] === `Ouvrir ${file.originalName}`)(); await settle();
    expect(commandCalls('open_attachment')).toEqual([['open_attachment', { id: file.id, expectedWorkspaceScope: origin }]]);
  });
});
