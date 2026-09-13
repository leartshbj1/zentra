import { describe, expect, it } from 'vitest';
import type { SupplierInvoice, Workspace } from './types';
import { changePurchaseDate, purchaseDecimal, purchaseFields, purchaseIssue, purchaseLineField, purchaseLineValue, purchaseTotals, supplierInvoiceLineTotals } from './supplierInvoicePreparation';

const workspace = {
  settings: { organization: { vatRegistered: true }, billing: { paymentTermsDays: 30, vatRatesBp: [810, 260, 0] }, work: { costCategories: ['Fournitures'] } },
  suppliers: [{ id: 'one', name: 'Premier', paymentTermsDays: 30, archivedAt: null }],
} as unknown as Workspace;
const prepared = () => { const fields = purchaseFields(workspace, undefined, '2026-09-13'); fields.lines[0].description = 'Fournitures'; fields.lines[0].price = '100'; return fields; };

describe('préparer une facture fournisseur', () => {
  it('conserve les décimales exactes et refuse une saisie trop précise ou mal formée', () => {
    expect(purchaseDecimal(' 123,45 ', 2, 10_000_000_000)).toBe(12345);
    expect(purchaseDecimal('0.001', 3, 1_000_000_000)).toBe(1);
    expect(purchaseDecimal('100000000.00', 2, 10_000_000_000)).toBe(10_000_000_000);
    for (const text of ['', ' ', '1.234', '-1', '1e3', '1,2.3', '100000000.01', '9'.repeat(65)]) expect(purchaseDecimal(text, 2, 10_000_000_000)).toBeNull();
  });
  it('ne choisit pas un fournisseur arbitraire quand il y en a plusieurs', () => {
    expect(purchaseFields(workspace).supplierId).toBe('one');
    expect(purchaseFields({ ...workspace, suppliers: [...workspace.suppliers, { ...workspace.suppliers[0], id: 'two' }] }).supplierId).toBe('');
    expect(purchaseFields({ ...workspace, suppliers: [] }).supplierId).toBe('');
  });
  it('fait suivre le délai habituel en conservant toute échéance manuelle', () => {
    const fields = prepared();
    expect(changePurchaseDate(fields, 'date', '2026-09-20', workspace).dueDate).toBe('2026-10-20');
    expect(changePurchaseDate({ ...fields, dueDate: '2026-10-22' }, 'date', '2026-09-20', workspace).dueDate).toBe('2026-10-22');
    expect(changePurchaseDate({ ...fields, dueDate: '' }, 'date', '2026-09-20', workspace).dueDate).toBe('');
    expect(changePurchaseDate(fields, 'date', '', workspace).dueDate).toBe(fields.dueDate);
    const other = { ...workspace, suppliers: [...workspace.suppliers, { ...workspace.suppliers[0], id: 'two', paymentTermsDays: 14 }] };
    expect(changePurchaseDate(fields, 'supplierId', 'two', other).dueDate).toBe('2026-09-27');
    expect(changePurchaseDate({ ...fields, dueDate: '2026-10-22' }, 'supplierId', 'two', other).dueDate).toBe('2026-10-22');
  });
  it('dirige les erreurs vers leur étape et leur champ sans modifier les valeurs', () => {
    const fields = prepared(); fields.lines[0].quantity = '1,0001';
    expect(purchaseIssue(fields, [810, 260, 0], 0)).toBeNull();
    expect(purchaseIssue(fields, [810, 260, 0])).toMatchObject({ step: 1, field: purchaseLineField(fields.lines[0].id, 'quantity') });
    expect(fields.lines[0].quantity).toBe('1,0001');
    expect(purchaseTotals(fields.lines)).toBeNull();
    expect(purchaseIssue({ ...fields, dueDate: '2026-09-01' }, [810])).toMatchObject({ step: 0, field: 'dueDate' });
  });
  it('retrouve une remise invalide dans les options et un taux devenu indisponible', () => {
    const fields = prepared(); fields.lines[0].discount = '100,001';
    expect(purchaseIssue(fields, [810])).toMatchObject({ field: purchaseLineField(fields.lines[0].id, 'discount') });
    fields.lines[0].discount = ''; fields.lines[0].vatBp = 770;
    expect(purchaseIssue(fields, [810])).toMatchObject({ field: purchaseLineField(fields.lines[0].id, 'vatBp') });
    fields.lines[0].vatBp = 810;
    expect(purchaseLineValue(fields.lines[0])?.discountBp).toBe(0);
  });
  it('arrondit les lignes comme le moteur natif après avoir validé la précision saisie', () => {
    const fields = prepared(); Object.assign(fields.lines[0], { quantity: '1,5', price: '10,05', discount: '2,5' });
    expect(supplierInvoiceLineTotals(purchaseLineValue(fields.lines[0])!)).toEqual({ netCents: 1470, vatCents: 119, totalCents: 1589 });
    expect(purchaseIssue(fields, [810])).toBeNull();
    expect(purchaseTotals(fields.lines)).toEqual({ netCents: 1470, vatCents: 119, totalCents: 1589 });
  });
  it('refuse les totaux hors de la précision JavaScript et les lignes vides', () => {
    const fields = prepared(); Object.assign(fields.lines[0], { quantity: '1000000', price: '100000000' });
    expect(purchaseTotals(fields.lines)).toBeNull();
    expect(purchaseIssue(fields, [810])).toMatchObject({ step: 1, field: 'purchase-lines' });
    expect(purchaseIssue({ ...fields, lines: [] }, [810])).toMatchObject({ step: 1, field: 'purchase-lines' });
  });
  it('conserve les comptes, projets, dates et identifiants d’une facture existante', () => {
    const fields = prepared(), line = purchaseLineValue(fields.lines[0])!;
    const item = { id: 'invoice', supplierId: 'one', reference: 'F-42', documentDate: '2026-09-01', dueDate: '2026-10-12', projectId: 'project', note: 'Deux\nlignes', lines: [{ ...line, expenseAccountId: 'custom-account', projectId: 'other-project' }] } as unknown as SupplierInvoice;
    const draft = purchaseFields(workspace, item);
    expect(draft).toMatchObject({ reference: 'F-42', dueDate: '2026-10-12', projectId: 'project', note: 'Deux\nlignes' });
    expect(purchaseLineValue(draft.lines[0])).toMatchObject({ id: line.id, expenseAccountId: 'custom-account', projectId: 'other-project', quantityMilli: 1000, unitPriceCents: 10000 });
  });
});
