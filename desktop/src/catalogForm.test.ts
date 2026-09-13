import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
import { catalogDraft, catalogFormData, catalogFormIssue, catalogMoneyInput, catalogNativeIssue, catalogPricePreview, catalogVatRates, catalogWasSaved, CatalogSaveRefreshError, CatalogSaveUnknownError, formatCatalogMoney, mergeCatalogDraft, parseCatalogMoney, type CatalogDraft } from './catalogForm';
import { initialOnboardingSettings } from './onboardingDraft';
import type { CatalogItem, Workspace } from './types';
const settings = structuredClone(initialOnboardingSettings);
settings.organization.vatRegistered = true; settings.billing.vatRatesBp = [810, 260, 380, 0];
const draft: CatalogDraft = { ...catalogDraft(undefined, settings), name: ' Pose ', unit: ' heure ', salesPrice: '85,50', description: 'Texte\nSuite', vatBp: '810' };
const data = catalogFormData(draft, false);
const item = { ...data, id: 'reference', updatedAt: 'version', createdAt: 'version', archivedAt: null } as CatalogItem;
const workspace = (row = item) => ({ onboardingCompleted: true, settings, catalogItems: [row], stockMovements: [] }) as unknown as Workspace;
afterEach(() => invoke.mockReset());

describe('fiche catalogue', () => {
  it('preserves exact centimes and rejects values that used to turn into zero', () => {
    expect(parseCatalogMoney(' 85,50 ')).toBe(8550);
    expect(parseCatalogMoney('89999999999999.99')).toBe(8_999_999_999_999_999);
    expect(catalogMoneyInput(8_999_999_999_999_999)).toBe('89999999999999.99');
    expect(formatCatalogMoney(8_999_999_999_999_999).replace(/[\s’']/g, '')).toBe('89999999999999,99CHF');
    for (const value of ['', ' ', 'bad', '1e3', '-1', '85.555', '90000000000000.01', '1,2.3']) expect(parseCatalogMoney(value)).toBeNull();
    expect(parseCatalogMoney('0')).toBe(0);
  });
  it('previews one unit and tax without altering the saved net price', () => {
    expect(catalogPricePreview('100', '810')).toEqual({ netCents: 10000, vatCents: 810, totalCents: 10810 });
    expect(catalogPricePreview('0.05', '810')).toEqual({ netCents: 5, vatCents: 0, totalCents: 5 });
    expect(catalogPricePreview('90000000000000', '810')).toBeNull();
    expect(data).toMatchObject({ salesPriceCents: 8550, purchaseCostCents: 0, name: 'Pose', unit: 'heure', trackStock: false, stockQuantityMilli: 0 });
  });
  it('does not replace an unsafe historical purchase cost with an empty zero-valued field', () => {
    const restored = catalogDraft({ ...item, purchaseCostCents: Number.MAX_SAFE_INTEGER + 1 }, settings);
    expect(restored.purchaseCost).toBe('Valeur à vérifier');
    expect(catalogFormIssue(restored, [810])?.field).toBe('purchaseCost');
    expect(formatCatalogMoney(Number.MAX_SAFE_INTEGER + 1)).toBe('—');
  });
  it('guides every invalid field and opens optional inputs rather than swallowing errors', () => {
    expect(catalogFormIssue(draft, [810])).toBeNull();
    for (const [field, value] of [['name', ' '], ['unit', ''], ['salesPrice', 'abc'], ['purchaseCost', '2.111'], ['sku', 'x'.repeat(81)], ['description', 'x'.repeat(10001)], ['vatBp', 'NaN']] as const) {
      expect(catalogFormIssue({ ...draft, [field]: value }, [810])?.field).toBe(field);
    }
    expect(catalogFormIssue({ ...draft, kind: 'product', trackStock: true, reorderLevel: '1.0001' }, [810])?.field).toBe('reorderLevel');
    expect(catalogFormIssue({ ...draft, kind: 'service', reorderLevel: 'bad' }, [810])).toBeNull();
    expect(catalogFormData({ ...draft, kind: 'product', reorderLevel: '2,125' }, true)).toMatchObject({ trackStock: true, reorderLevelMilli: 2125 });
    expect(catalogFormData(draft, true)).not.toHaveProperty('stockQuantityMilli');
  });
  it('keeps a historical rate visible but does not silently apply it to a non-registered company', () => {
    const nonRegistered = { ...settings, organization: { ...settings.organization, vatRegistered: false } };
    expect(catalogVatRates(nonRegistered, item)).toEqual([0, 810]);
    expect(catalogDraft(item, nonRegistered).vatBp).toBe('810');
    expect(catalogFormIssue(draft, [0])?.field).toBe('vatBp');
  });
  it('merges independent changes and preserves the local choice for an actual conflict', () => {
    const local = { ...draft, salesPrice: '95', description: 'Mon texte' };
    const current = { ...draft, name: 'Nouveau nom', salesPrice: '105', unit: 'forfait' };
    expect(mergeCatalogDraft(draft, local, current)).toEqual({ ...current, salesPrice: '95', description: 'Mon texte' });
    expect(local).toEqual({ ...draft, salesPrice: '95', description: 'Mon texte' });
  });
  it('preserves stock history and refuses incompatible type changes before writing', () => {
    const product = { ...item, kind: 'product' as const, trackStock: true };
    expect(catalogFormIssue(draft, [810], product, true)?.field).toBe('kind');
    expect(catalogNativeIssue('stock tracking cannot change after the first movement')?.field).toBe('trackStock');
    expect(catalogNativeIssue('sales_price_cents doit être positif')?.field).toBe('salesPrice');
  });
  it('requires a readable catalogue and verifies update results without confusing later stock changes', () => {
    expect(catalogWasSaved(workspace({ ...item, stockQuantityMilli: 5000 }), 'reference', data)).toBe(true);
    expect(catalogWasSaved(workspace({ ...item, salesPriceCents: 123 }), 'reference', data)).toBe(false);
    expect(() => catalogWasSaved({ ...workspace(), settings: null }, 'reference', data)).toThrow();
  });
});

describe.each([false, true])('production bridge editing=%s', editing => {
  const command = editing ? 'update_catalog_item' : 'create_record';
  const raw = () => ({ settings: { company_name: 'Entreprise', extra_settings_json: '{}' }, catalog_items: [{ id: 'reference', kind: 'service', name: 'Pose', unit: 'heure', description: 'Texte\nSuite', sales_price_cents: 8550, purchase_cost_cents: 0, vat_bp: 810, track_stock: 0, stock_quantity_milli: 0, reorder_level_milli: 0, updated_at: 'next' }] });
  const run = () => desktopApi.saveCatalogItem('reference', catalogFormData(draft, editing), editing ? 'version' : undefined);
  it('sends exact cents, a stable id and the expected version in a single command', async () => {
    invoke.mockImplementation(async name => name === command ? {} : name === 'get_app_state' ? { onboarding_completed: true } : raw());
    expect((await run()).catalogItems).toHaveLength(1);
    const args = invoke.mock.calls[0][1];
    expect(args.data).toMatchObject({ name: 'Pose', unit: 'heure', sales_price_cents: 8550, purchase_cost_cents: 0 });
    if (editing) { expect(args).toMatchObject({ id: 'reference', expectedUpdatedAt: 'version' }); expect(args.data).not.toHaveProperty('stock_quantity_milli'); }
    else { expect(args.entity).toBe('catalog_items'); expect(args.data).toMatchObject({ id: 'reference', stock_quantity_milli: 0 }); }
    expect(invoke.mock.calls.map(row => row[0])).toEqual([command, 'get_app_state', 'get_workspace']);
  });
  it('recognizes a lost reply by reading without resending', async () => {
    invoke.mockImplementation(async name => { if (name === command) throw Error('Réponse perdue'); return name === 'get_app_state' ? { onboarding_completed: true } : raw(); });
    const error = await run().catch(error => error); expect(error).toBeInstanceOf(CatalogSaveUnknownError);
    expect(error.wasRecorded(await desktopApi.loadWorkspace())).toBe(true);
    expect(invoke.mock.calls.filter(row => row[0] === command)).toHaveLength(1);
  });
  it('holds an acknowledged write across unreadable, empty and missing-record reads', async () => {
    invoke.mockImplementation(async name => { if (name === command) return {}; throw Error('Lecture interrompue'); });
    const error = await run().catch(error => error); expect(error).toBeInstanceOf(CatalogSaveRefreshError);
    expect(() => error.validateRead({ ...workspace(), onboardingCompleted: false })).toThrow();
    expect(() => error.validateRead({ ...workspace(), catalogItems: [] })).toThrow();
    // A later edit cannot make an acknowledged save pending forever.
    expect(() => error.validateRead(workspace({ ...item, name: 'Modifié après l’acquittement' }))).not.toThrow();
    expect(invoke.mock.calls.filter(row => row[0] === command)).toHaveLength(1);
  });
});
