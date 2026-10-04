// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
import './languageTestPacks';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopApi } from './bridge';
import { VatCenter } from './VatCenter';
import { VatPurchaseReview } from './VatPurchaseReview';
import { VatPreClosingReview } from './VatPreClosingReview';
import { VatReceivedPayments } from './VatReceivedPayments';
import { VatSalesSourceReview } from './VatSalesSourceReview';
import { initialOnboardingSettings } from './onboardingDraft';
import { setAppLanguage, t, type AppLanguage } from './language';
import type { VatProfile, VatReturnPreview, VatReturnExport, Workspace } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));
const languages = ['fr', 'de', 'it', 'en'] as const;
const copy = {
  fr: ['TVA due et récupérable', 'Méthode & autorisation', 'Corrections du décompte', 'Version enregistrée', 'Transmission à l’AFC', 'Achats courants (400)', 'Remboursement fournisseur'],
  de: ['Geschuldete und abziehbare MWST', 'Methode & Bewilligung', 'Abrechnungskorrekturen', 'Gespeicherte Version', 'Übermittlung an die ESTV', 'Laufende Einkäufe (400)', 'Lieferantenrückerstattung'],
  it: ['IVA dovuta e detraibile', 'Metodo e autorizzazione', 'Correzioni del rendiconto', 'Versione registrata', 'Trasmissione all’AFC', 'Acquisti correnti (400)', 'Rimborso del fornitore'],
  en: ['VAT due and recoverable', 'Method & authorisation', 'Return corrections', 'Saved version', 'Submission to the FTA', 'Current purchases (400)', 'Supplier refund'],
} satisfies Record<AppLanguage, string[]>;
const filter = { dateFrom: '2026-01-01', dateTo: '2026-03-31' };
const profile: VatProfile = { id: 'native-profile', effectiveFrom: '2026-01-01', effectiveTo: null, reportingMethod: 'effective', formOfReporting: 'agreed', periodicity: 'quarterly', grossOrNet: 'net', tdfnActivityId: null, tdfnRateBp: null, afcAuthorizationConfirmed: true, notes: 'Méthode client {rate}', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const source = { sourceType: 'expense' as const, sourceId: 'raw-expense', parentId: 'raw-expense', occurrenceDate: '2026-02-03', description: 'Client – été {name}', amountCents: 12345, vatCents: 1000, vatRateBp: 810 };
const preview: VatReturnPreview = { standard: 'eCH-0217', standardVersion: '2.0.0', currency: 'CHF', profile, ...filter, submissionType: 'initial', exportable: true, blockingIssues: [], warnings: [], unclassifiedSources: [source], classifiedSources: [], receivedAllocations: [], preClosingSources: [], sourceSha256: 'RAW-SOURCE-HASH', turnoverComputation: { totalConsiderationCents: 12345, taxableTurnoverCents: 12345, suppliesToForeignCountriesCents: 0, suppliesAbroadCents: 0, transferNotificationProcedureCents: 0, suppliesExemptFromTaxCents: 0, reductionOfConsiderationCents: 0, variousDeduction: null }, effectiveReportingMethod: { grossOrNet: 'net', grossOrNetCode: 1, optedCents: 0, suppliesPerTaxRate: [{ taxRateBp: 810, turnoverCents: 12345, calculatedTaxCents: 1000 }], acquisitionTax: [], inputTaxMaterialAndServicesCents: 0, inputTaxInvestmentsCents: 0, subsequentInputTaxDeductionCents: 0, inputTaxCorrectionsCents: 0, inputTaxReductionsCents: 0, outputTaxCents: 1000, acquisitionTaxCents: 0 }, simpleTaxRateMethod: null, payableTaxCents: 1000, payableCode: '500', otherFlowsOfFunds: { subsidiesCents: 0, donationsCents: 0 }, sourceCount: 1, adjustmentCount: 0, transmissionWording: "Généré localement pour contrôle et import manuel; aucune transmission AFC n'a été effectuée." };
const workspace = { settings: { ...initialOnboardingSettings, organization: { ...initialOnboardingSettings.organization, contactName: 'Saisi par le client {name}' } }, invoices: [], payments: [], expenses: [], supplierInvoices: [], supplierInvoicePayments: [], supplierCreditNotes: [] } as unknown as Workspace;
let host: HTMLDivElement;
let root: Root;
let currentPreview: VatReturnPreview;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  currentPreview = structuredClone(preview);
  vi.spyOn(desktopApi, 'listVatProfiles').mockResolvedValue([profile]);
  vi.spyOn(desktopApi, 'listVatAdjustments').mockResolvedValue([]);
  vi.spyOn(desktopApi, 'listVatReturnExports').mockResolvedValue([]);
  vi.spyOn(desktopApi, 'listVatSourceClassifications').mockResolvedValue([]);
  vi.spyOn(desktopApi, 'previewVatReturn').mockImplementation(async () => currentPreview);
  vi.spyOn(desktopApi, 'createVatProfile').mockResolvedValue(profile);
  vi.spyOn(desktopApi, 'setVatSourceClassification').mockResolvedValue({} as never);
  vi.spyOn(desktopApi, 'createVatAdjustment').mockResolvedValue({} as never);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await setAppLanguage('fr'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(language: AppLanguage) { await act(async () => { await setAppLanguage(language); root.render(<VatCenter filter={filter} workspace={workspace} />); }); await wait(() => !!host.querySelector('.vat-summary')); }
async function wait(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); }); expect(check(), host.textContent ?? '').toBe(true); }
async function click(source: string, within: ParentNode = document) { const target = [...within.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === t(source).trim()); expect(target, source).toBeDefined(); await act(async () => target!.click()); }
async function fill(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) { await act(async () => { const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function submit(form: HTMLFormElement) { await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }

describe('real VAT presentation and unchanged input/output facts', () => {
  it.each(languages)('translates profile fields, preserves draft input through language changes, and saves native values in %s', async language => {
    await mount(language);
    expect(host.querySelector('h2')?.textContent).toBe(copy[language][0]);
    expect(host.querySelector('.closing-limitation strong')?.textContent).toBe(copy[language][4]);
    await click('Méthode & autorisation');
    expect(host.querySelector('.vat-profile-status')?.textContent).toBe(copy[language][3]);
    const form = host.querySelector<HTMLFormElement>('.vat-profile-form')!;
    const selectors = [...form.querySelectorAll<HTMLSelectElement>('select')];
    await fill(selectors[0], 'simple_tax_rate'); await fill(selectors[1], 'received');
    await fill(form.querySelector<HTMLInputElement>('[name="activityId"]')!, '54321');
    await fill(form.querySelector<HTMLInputElement>('[name="tdfnRate"]')!, '6.20');
    await fill(form.querySelector<HTMLTextAreaElement>('[name="notes"]')!, 'Décision du client – été {rate}');
    form.querySelector<HTMLInputElement>('[name="authorization"]')!.checked = true;
    for (const next of languages) {
      await act(async () => { await setAppLanguage(next); });
      expect(form.querySelector<HTMLTextAreaElement>('[name="notes"]')!.value).toBe('Décision du client – été {rate}');
      expect(selectors[0].value).toBe('simple_tax_rate'); expect(selectors[1].value).toBe('received'); expect(selectors[2].value).toBe('semiannual'); expect(selectors[3].value).toBe('gross');
      expect(form.querySelector<HTMLInputElement>('[name="activityId"]')!.value).toBe('54321');
      expect(form.querySelector('[name="tdfnRate"]')?.closest('label')?.textContent).toContain(t('Taux TDFN/TaF confirmé (%)'));
    }
    await submit(form); expect(desktopApi.createVatProfile).not.toHaveBeenCalled();
    await click('Enregistrer cette version');
    expect(desktopApi.createVatProfile).toHaveBeenCalledExactlyOnceWith({ effectiveFrom: '2026-01-01', effectiveTo: '', reportingMethod: 'simple_tax_rate', formOfReporting: 'received', periodicity: 'semiannual', grossOrNet: 'gross', tdfnActivityId: '54321', tdfnRateBp: 620, afcAuthorizationConfirmed: true, notes: 'Décision du client – été {rate}', closePreviousOpenProfile: false });
    expect(profile.notes).toBe('Méthode client {rate}');
  });
  it.each(languages)('translates native treatment options while keeping IDs, cents and classification payload in %s', async language => {
    await mount(language);
    const original = JSON.stringify(currentPreview);
    const select = host.querySelector<HTMLSelectElement>('.vat-unclassified select')!;
    expect(select.getAttribute('aria-label')).toContain(source.description);
    const labels = { fr: 'Ch. 400 · impôt préalable matériel et prestations', de: 'Ziff. 400 · Vorsteuer auf Material und Dienstleistungen', it: 'Cifra 400 · imposta precedente su materiale e prestazioni', en: 'Box 400 · input tax on materials and services' };
    expect(select.querySelector('[value="input_materials"]')?.textContent).toBe(labels[language]);
    await fill(select, 'input_investments');
    expect(desktopApi.setVatSourceClassification).toHaveBeenCalledExactlyOnceWith({ sourceId: 'raw-expense', sourceType: 'expense', treatment: 'input_investments' });
    expect(JSON.stringify(currentPreview)).toBe(original);
  });
  it.each(languages)('keeps manual export reference, dates, profile and native not-transmitted facts in %s', async language => {
    const exported = { id: 'export', sequence: 1, profileId: profile.id, ...filter, submissionType: 'initial', sourceSha256: 'RAW-SOURCE-HASH', payload: preview, xmlSha256: '1234567890abcdef1234567890abcdef', fileName: 'Client – été.xml', filePath: 'D:/Client – été.xml', createdAt: '2026-03-31', transmissionStatus: 'not_transmitted', transmissionWording: preview.transmissionWording } as VatReturnExport;
    vi.spyOn(desktopApi, 'exportVatReturnXml').mockResolvedValue(exported);
    await mount(language);
    const form = host.querySelector<HTMLFormElement>('.vat-export-form')!;
    await fill(form.querySelector<HTMLInputElement>('[name="businessReferenceId"]')!, '  CHE-CLIENT-été-{id}  ');
    await submit(form);
    expect(desktopApi.exportVatReturnXml).toHaveBeenCalledExactlyOnceWith({ ...filter, submissionType: 'initial', profileId: 'native-profile', businessReferenceId: 'CHE-CLIENT-été-{id}' });
    expect(host.querySelector('.vat-export-success')?.textContent).toContain('D:/Client – été.xml');
    expect(host.querySelector('.vat-export-success')?.textContent).toContain(t('… · non transmis'));
    expect(exported.transmissionStatus).toBe('not_transmitted');
  });
  it.each(languages)('translates recognized native issues only and preserves changed or unknown source messages in %s', async language => {
    const exact = "Décompte bloqué : renseignez le numéro IDE/TVA CHE de l'entreprise.";
    currentPreview.exportable = false;
    currentPreview.blockingIssues = [
      { code: 'missing_uid', message: exact, sourceType: null, sourceId: null },
      { code: 'missing_uid', message: exact + ' CHE-123.456.789', sourceType: null, sourceId: null },
      { code: 'new_native_code', message: 'Détail natif 12345 cents / 810 bp {rate}', sourceType: null, sourceId: 'raw-expense' },
    ];
    await mount(language);
    const messages = [...host.querySelectorAll('.vat-issues p')].map(p => p.textContent);
    expect(messages).toEqual([t(exact), exact + ' CHE-123.456.789', 'Détail natif 12345 cents / 810 bp {rate}']);
    if (language !== 'fr') expect(messages[0]).not.toBe(exact);
    expect(host.querySelector<HTMLButtonElement>('.vat-export-form button')?.disabled).toBe(true);
  });
  it.each(languages)('translates adjustment catalogues but submits the entered reason, cents, rate and actor unchanged in %s', async language => {
    await mount(language); await click('Ajustements');
    expect(host.querySelector('.section-heading__eyebrow, .section-eyebrow')?.textContent ?? host.textContent).toContain(copy[language][2]);
    const form = host.querySelector<HTMLFormElement>('.vat-adjustment-form')!;
    await fill(form.querySelector<HTMLSelectElement>('select')!, 'acquisition_tax');
    await fill(form.querySelector<HTMLInputElement>('[name="amount"]')!, '-12.34');
    await fill(form.querySelector<HTMLInputElement>('[name="taxRate"]')!, '8.10');
    await fill(form.querySelector<HTMLInputElement>('[name="description"]')!, 'Client – été {name}');
    await fill(form.querySelector<HTMLInputElement>('[name="evidenceReference"]')!, 'AFC-RAW-123');
    await submit(form);
    expect(desktopApi.createVatAdjustment).toHaveBeenCalledOnce();
    expect(vi.mocked(desktopApi.createVatAdjustment).mock.calls[0][0]).toEqual({ requestId: expect.any(String), adjustmentDate: '2026-03-31', category: 'acquisition_tax', amountCents: -1234, taxRateBp: 810, description: 'Client – été {name}', evidenceReference: 'AFC-RAW-123', createdBy: 'Saisi par le client {name}' });
  });
  it.each(languages)('supports translated purchase/refund search and pre-closing choices without changing source facts in %s', async language => {
    const classify = vi.fn(async () => undefined);
    const purchase = { ...source, treatment: 'input_materials' as const, currency: 'CHF' };
    const allocation = { sourceType: 'supplier_credit_note_item' as const, sourceId: 'credit-line', parentId: 'credit', description: 'Avoir – été {name}', currency: 'CHF', paymentId: 'native-payment', date: '2026-02-03', grossCents: -13345, netCents: -12345, vatCents: -1000, settlement: { kind: 'credit_refund' as const, counterpartId: 'raw-counterpart', counterpartReference: 'RAW-REFERENCE', reversesAllocationId: null } };
    await act(async () => { await setAppLanguage(language); root.render(<><VatPurchaseReview sources={[purchase]} busy={false} onClassify={classify} /><VatPreClosingReview sources={[{ ...source, sourceId: 'unpaid', currency: 'CHF' }]} busy={false} onClassify={classify} /><VatReceivedPayments allocations={[allocation]} /></>); });
    const purchaseRoot = host.querySelector('.vat-purchase-review')!;
    expect(purchaseRoot.querySelector('[value="input_materials"]')?.textContent).toBe(copy[language][5]);
    await fill(purchaseRoot.querySelector<HTMLInputElement>('input')!, t('Impôt préalable matériel et prestations'));
    expect(purchaseRoot.querySelector('article strong')?.textContent).toBe(source.description);
    await fill(purchaseRoot.querySelector<HTMLSelectElement>('select')!, 'non_deductible');
    expect(classify).toHaveBeenCalledWith('raw-expense', 'expense', 'non_deductible');
    const preClose = host.querySelector('.vat-pre-closing-review')!;
    await fill(preClose.querySelector<HTMLSelectElement>('select')!, 'input_investments');
    expect(classify).toHaveBeenCalledWith('unpaid', 'expense', 'input_investments');
    expect(preClose.querySelector<HTMLSelectElement>('select')?.value).toBe('');
    const payments = host.querySelector('.vat-received-payments')!;
    await fill(payments.querySelector<HTMLInputElement>('input')!, copy[language][6]);
    await fill(payments.querySelector<HTMLSelectElement>('select')!, 'credits');
    expect(payments.querySelector('article strong')?.textContent).toBe(allocation.description);
    expect(payments.textContent).toContain('RAW-REFERENCE');
    expect(allocation).toMatchObject({ grossCents: -13345, netCents: -12345, vatCents: -1000, paymentId: 'native-payment' });
  });
  it.each(languages)('finds sales by the displayed translated treatment and opens the same persisted document in %s', async language => {
    const invoice = { id: 'raw-invoice', number: 'RAW-SALE-42', title: 'Client – été {name}', type: 'standard', status: 'issued', nativeDocumentState: { status: 'emise', number: 'RAW-SALE-42' }, issueDate: '2026-02-03', currency: 'CHF', lines: [{ id: 'raw-line', description: 'Prestation du client {rate}', quantity: 99, unitPriceCents: 999999, vatRateBp: 810, recordedAmounts: { netCents: 12345, vatCents: 1000, totalCents: 13345 } }] } as Workspace['invoices'][number];
    const data = { ...workspace, invoices: [invoice] };
    const open = vi.fn();
    await act(async () => { await setAppLanguage(language); root.render(<VatSalesSourceReview workspace={data} preview={preview} classifications={[{ id: 'raw-classification', sourceType: 'invoice_item', sourceId: 'raw-line', treatment: 'supplies_abroad', note: '', createdAt: '', updatedAt: '' }]} busy={false} onOpenSource={open} />); });
    const labels = { fr: 'Ch. 221 · prestations fournies à l’étranger', de: 'Ziff. 221 · im Ausland erbrachte Leistungen', it: 'Cifra 221 · prestazioni fornite all’estero', en: 'Box 221 · supplies provided abroad' };
    const review = host.querySelector('.vat-sales-source-review')!;
    await fill(review.querySelector<HTMLInputElement>('input')!, labels[language]);
    expect(review.querySelector('article strong')?.textContent).toContain('RAW-SALE-42');
    await click('Ouvrir la pièce', review);
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'raw-invoice', kind: 'invoice' }));
    expect(invoice.lines[0].recordedAmounts).toEqual({ netCents: 12345, vatCents: 1000, totalCents: 13345 });
    expect(invoice.nativeDocumentState).toEqual({ status: 'emise', number: 'RAW-SALE-42' });
  });
});
