import { describe, expect, it } from 'vitest';
import { prepareMailboxBatch } from './supplierInboxBatch';
import type { MailboxBatch } from './supplierInboxBatch';
import type { MailInvoice, SupplierInboxState } from './supplierInbox';
import type { Workspace } from './types';

function fixture(count = 12) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `invoice-${i}`, organizationId: 'org', fileName: `invoice-${i}.pdf`, mediaType: 'application/pdf',
    sha256: 'test', subject: `Invoice ${i}`, invoiceId: null, automatic: false, createdAt: i,
    sender: 'billing@intermediary.test', state: 'review',
    otherDevice: false, extraction: { kind: 'unknown', kindConfidence: .5, confidence: 0,
      fieldConfidence: { supplierName: .99 }, supplierName: `Supplier ${i % 4}`, reference: `TEST-${i}`,
      invoiceDate: '2026-09-22', dueDate: '2026-10-22', currency: 'CHF', netCents: 10000,
      vatCents: 810, totalCents: 10810, vatBp: 810, category: 'materials', issues: ['Type à confirmer'], evidence: {} },
  })) as MailInvoice[];
  const inbox: SupplierInboxState = { organizationId: 'org', linked: true, prepareEnabled: true, autoPost: false, automationActive: true, items, habits: [] };
  const workspace = { suppliers: [], supplierInvoices: [], accounts: [] } as unknown as Workspace;
  const calls: Record<string, any>[] = [];
  const saved = new Map<string, { supplier: string; note: string }>();
  const progress: MailboxBatch[] = [];
  let current = true;
  const request = async <T>(raw: unknown): Promise<T> => {
    const action = raw as Record<string, any>; calls.push(action);
    if (action.action === 'prepareSuppliers') return { results: action.ids.map((id: string) => {
      const item = inbox.items.find(i => i.id === id)!;
      if (item.extraction.fieldConfidence?.supplierName !== .99) return { id, error: 'Le nom du fournisseur doit être confirmé.' };
      let supplier = workspace.suppliers.find(s => s.name === item.extraction.supplierName);
      const created = !supplier;
      if (!supplier) { supplier = { id: `supplier-${workspace.suppliers.length}`, name: item.extraction.supplierName!, email: '', archivedAt: null } as Workspace['suppliers'][number]; workspace.suppliers.push(supplier); }
      return { id, supplierId: supplier.id, created };
    }) } as T;
    if (action.automatic) throw Error('Le classement doit être confirmé.');
    if (!saved.has(action.id)) saved.set(action.id, { supplier: action.invoice.supplier_id, note: 'original' });
    return { id: action.id, saved: true, posted: false } as T;
  };
  return { inbox, workspace, calls, saved, progress, switchCompany: () => { current = false; },
    dependencies: { request, loadWorkspace: async () => workspace, isCurrent: () => current,
      progress: (batch: MailboxBatch) => progress.push(batch) } };
}

describe('Traitement groupé réel de la file fournisseurs', () => {
  it('prépare 12 factures avec quatre fournisseurs distincts, sans un choix par facture', async () => {
    const f = fixture();
    const result = await prepareMailboxBatch(f.inbox, f.dependencies);
    expect(result.done).toBe(12);
    expect(result.results.every(r => r.status === 'draft' && r.supplierId)).toBe(true);
    expect(f.workspace.suppliers).toHaveLength(4);
    expect(f.saved.size).toBe(12);
    for (let i = 0; i < 12; i++) expect(f.saved.get(`invoice-${i}`)?.supplier).toBe(`supplier-${i % 4}`);
    expect(f.calls.filter(c => c.action === 'prepareSuppliers').map(c => c.ids.length)).toEqual([10, 2]);
    expect(f.calls.filter(c => c.action === 'import').every(c => c.confirm === false && c.automatic === false)).toBe(true);
    expect(f.progress.at(-1)?.done).toBe(12);
  });
  it('renseigne le fournisseur même si le montant doit être corrigé, et poursuit les autres factures', async () => {
    const f = fixture(3); f.inbox.items[1].extraction.netCents = null;
    const result = await prepareMailboxBatch(f.inbox, f.dependencies);
    expect(result.results.map(r => r.status)).toEqual(['draft', 'review', 'draft']);
    expect(result.results[1]).toMatchObject({ supplierId: 'supplier-1', supplierCreated: true, message: 'Les montants ou la TVA doivent être vérifiés.' });
    expect(f.saved.size).toBe(2);
  });
  it('ne crée pas de fournisseur incertain et ne bloque pas les autres documents', async () => {
    const f = fixture(3); f.inbox.items[1].extraction.fieldConfidence!.supplierName = .4;
    // A coincidentally matching name must not bypass the native confidence check.
    f.workspace.suppliers.push({ id: 'existing', name: 'Supplier 1', email: '', archivedAt: null } as Workspace['suppliers'][number]);
    const result = await prepareMailboxBatch(f.inbox, f.dependencies);
    expect(result.results.map(r => r.status)).toEqual(['draft', 'review', 'draft']);
    expect(result.results[1].supplierId).toBeFalsy();
    expect(f.workspace.suppliers).toHaveLength(3);
  });
  it('réutilise les fournisseurs déjà présents et préserve une facture modifiée lors d’une reprise', async () => {
    const f = fixture(); await prepareMailboxBatch(f.inbox, f.dependencies);
    f.saved.get('invoice-3')!.note = 'edited';
    const result = await prepareMailboxBatch(f.inbox, f.dependencies);
    expect(result.results.every(r => r.status === 'draft' && !r.supplierCreated)).toBe(true);
    expect(f.workspace.suppliers).toHaveLength(4);
    expect(f.saved.size).toBe(12); expect(f.saved.get('invoice-3')!.note).toBe('edited');
  });
  it('conserve le garde-fou de comptabilisation automatique', async () => {
    const f = fixture(1); f.inbox.autoPost = true; f.inbox.items[0].state = 'ready';
    const result = await prepareMailboxBatch(f.inbox, f.dependencies);
    expect(f.calls.filter(c => c.action === 'import').map(c => c.automatic)).toEqual([true, false]);
    expect(result.results[0].status).toBe('draft');
  });
  it('n’importe rien après un changement d’entreprise', async () => {
    const f = fixture(); const original = f.dependencies.request;
    f.dependencies.request = async <T>(data: unknown) => { const r = await original<T>(data); f.switchCompany(); return r; };
    const result = await prepareMailboxBatch(f.inbox, f.dependencies);
    expect(result.done).toBe(0); expect(f.saved.size).toBe(0);
  });
  it('écarte les documents enregistrés, ignorés ou pris en charge par un autre appareil', async () => {
    const f = fixture(4); f.inbox.items[0].state = 'imported'; f.inbox.items[1].state = 'ignored'; f.inbox.items[2].otherDevice = true;
    const result = await prepareMailboxBatch(f.inbox, f.dependencies);
    expect(result.total).toBe(1); expect(result.results[0].id).toBe('invoice-3');
    f.inbox.prepareEnabled = false; f.calls.length = 0;
    await prepareMailboxBatch(f.inbox, f.dependencies); expect(f.calls).toHaveLength(0);
  });
});
