// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/** Real readiness/onboarding helpers and WorkspaceApp/settings/provider/bridge.
 * Only native IPC and unrelated background services are closed fixtures.
 * These checks do not certify a tax registration or execute a native command. */
import { act as reactAct, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopApi } from './bridge';
import { diagnosticsApi } from './diagnostics';
import { WorkspaceApp } from './WorkspaceApp';
import { FormDraftIdentityProvider } from './useFormDraft';
import { ZentraAssistantProvider } from './ZentraAssistant';
import { initialOnboardingSettings } from './onboardingDraft';
import { validateOnboarding } from './onboardingValidation';
import { buildSetupReadiness } from './SetupReadinessCenter';
import { setAppLanguage } from './language';
import type { AppSettings, NogaCatalog, Workspace } from './types';
import './languageTestPacks';

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: transport.invoke, isTauri: () => false }));
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });
  HTMLElement.prototype.scrollTo = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

const scope = 'vat-identifier-company';
const member = '11111111-1111-4111-8111-111111111111';
const nonce = 'a'.repeat(32);
// Synthetic, well-formed identifier, never a claim of registration in the UID register.
const uid = 'CHE-123.456.788';
const catalog: NogaCatalog = { version: '2025', source: 'local closed catalog', sections: [{ code: 'M', label: 'Conseil', divisions: [{ code: '69', label: 'Conseil' }] }] };

function validSettings(): AppSettings {
  const settings = structuredClone(initialOnboardingSettings);
  settings.organization = { ...settings.organization, legalName: 'Atelier témoin SA', legalForm: 'SA', contactName: 'Aline Exemple', email: 'aline@example.ch', uidNumber: uid, vatNumber: '', vatRegistered: true,
    address: { street: 'Rue du Lac', buildingNumber: '2', postalCode: '1000', city: 'Lausanne', canton: 'VD', country: 'CH' } };
  settings.business = { nogaSection: 'M', nogaDivision: '69', activityDescription: 'Conseil', nogaDetailedCode: '' };
  settings.billing = { ...settings.billing, iban: 'CH9300762011623852957', accountHolder: 'Atelier témoin SA', vatRatesBp: [810] };
  settings.work = { workWeekHours: 42, dailyHours: 8.4, roundingMinutes: 5, breakMinutes: 30, costCategories: ['Fournitures'] };
  settings.backup = { ...settings.backup, folder: 'D:/Sauvegardes', recoveryConfirmed: true };
  return settings;
}

function rawSettings(settings: AppSettings) {
  const org = settings.organization, billing = settings.billing;
  return { company_name: org.legalName, legal_form: org.legalForm, owner_name: org.contactName, email: org.email, phone: org.phone,
    address_line1: org.address.street, address_line2: '', postal_code: org.address.postalCode, city: org.address.city, canton: org.address.canton, country: org.address.country,
    uid_number: org.uidNumber, vat_number: org.vatNumber, vat_registered: org.vatRegistered,
    iban: billing.iban, bank_name: billing.accountHolder, currency: 'CHF', default_vat_bp: billing.vatRatesBp[0] ?? 0,
    quote_prefix: billing.quotePrefix, invoice_prefix: billing.invoicePrefix, credit_note_prefix: billing.creditNotePrefix,
    quote_start_number: billing.nextQuoteNumber, invoice_start_number: billing.nextInvoiceNumber, credit_note_start_number: billing.nextCreditNoteNumber,
    payment_terms_days: billing.paymentTermsDays, quote_validity_days: billing.quoteValidityDays,
    noga_section: settings.business.nogaSection, noga_division: settings.business.nogaDivision, activity_description: settings.business.activityDescription,
    extra_settings_json: JSON.stringify(settings) };
}

let root: Root | undefined, container: HTMLDivElement, settings: AppSettings;
let savedRow: Record<string, unknown> | undefined;
let writes: any[] = [], reads: any[] = [], publications: Workspace[] = [], externalRequests = 0;
const workspaceRaw = () => ({ work_notes_scope: scope, settings: savedRow ?? rawSettings(settings), projects: [], quotes: [], quote_items: [], clients: [], employees: [], time_entries: [] });

async function settle() {
  await reactAct(async () => { for (let index = 0; index < 25; index++) await Promise.resolve(); await new Promise<void>(resolve => setTimeout(resolve, 1)); });
}
async function click(text: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.trim() === text);
  expect(button, text).toBeDefined();
  expect(button!.disabled).toBe(false);
  await reactAct(async () => button!.click());
  await settle();
}
async function until(check: () => boolean) {
  for (let index = 0; index < 40 && !check(); index++) await settle();
  expect(check(), document.body.textContent ?? '').toBe(true);
}
function Host({ initial }: { initial: Workspace }) {
  const [current, setCurrent] = useState(initial);
  return <FormDraftIdentityProvider companyId={scope} organizationId="org-témoin" memberId={member} memberContextNonce={nonce} ready>
    <ZentraAssistantProvider><WorkspaceApp workspace={current} setWorkspace={next => { if (next && typeof next !== 'function') { publications.push(next); setCurrent(next); } }} /></ZentraAssistantProvider>
  </FormDraftIdentityProvider>;
}
async function openCompany(next = validSettings()) {
  settings = structuredClone(next);
  const initial = await desktopApi.loadWorkspace();
  root = createRoot(container);
  await reactAct(async () => root!.render(<Host initial={initial} />));
  await settle();
  await click('Paramètres');
  await reactAct(async () => { await vi.dynamicImportSettled(); });
  await until(() => document.querySelector('[data-settings-link="company"]') !== null);
  const link = document.querySelector<HTMLButtonElement>('[data-settings-link="company"]')!;
  await reactAct(async () => link.click());
  await settle();
  reads = [];
  const form = document.querySelector<HTMLFormElement>('#settings-company-identity form')!;
  expect(form).not.toBeNull();
  return form;
}
async function change(form: HTMLFormElement, name: string, value: string) {
  const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  expect(input, name).not.toBeNull();
  await reactAct(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
}

beforeEach(async () => {
  settings = validSettings(); savedRow = undefined; writes = []; reads = []; publications = []; externalRequests = 0;
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => { externalRequests++; throw Error('External requests are disabled in this fixture.'); }));
  HTMLCanvasElement.prototype.getContext = (() => ({ measureText: (value: string) => ({ width: value.length * 8 }) })) as never;
  transport.invoke.mockReset(); transport.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === 'clear_diagnostics') return null;
    if (command === 'get_app_state' || command === 'get_workspace') {
      reads.push({ command, args: structuredClone(args ?? {}) });
      if (args?.expectedWorkspaceScope !== undefined) expect(args.expectedWorkspaceScope).toBe(scope);
      if (args?.expectedMemberContextNonce !== undefined) expect(args.expectedMemberContextNonce).toBe(nonce);
      return command === 'get_app_state' ? { onboarding_completed: true } : workspaceRaw();
    }
    if (command === 'update_settings') { writes.push(structuredClone(args)); savedRow = structuredClone(args.data); settings = JSON.parse(args.data.extra_settings_json); return structuredClone(args.data); }
    throw Error('Native command outside this closed fixture: ' + command);
  });
  vi.spyOn(desktopApi, 'getCloudBackupState').mockResolvedValue({ enabled: false, connected: false, backups: [] } as never);
  vi.spyOn(desktopApi, 'getReminderSettings').mockResolvedValue({ enabled: false, senderName: '', lastScanAt: '' } as never);
  vi.spyOn(desktopApi, 'listReminderTemplates').mockResolvedValue([]); vi.spyOn(desktopApi, 'listReminders').mockResolvedValue([]);
  vi.spyOn(desktopApi, 'getSecureUpdatePolicy').mockResolvedValue({ enabled: false, reason: 'Closed fixture' } as never);
  vi.spyOn(desktopApi, 'getProjectSyncStatus').mockResolvedValue({ pending: 0, syncing: false, connected: false, documents: [] } as never);
  vi.spyOn(desktopApi, 'syncProjectDocuments').mockResolvedValue({ pending: 0, syncing: false, connected: false, documents: [] } as never);
  vi.spyOn(desktopApi, 'listPayrollContributionDefinitions').mockResolvedValue([]);
  vi.spyOn(desktopApi, 'getAccountingSettings').mockResolvedValue({ enabled: false } as never); vi.spyOn(desktopApi, 'listAccounts').mockResolvedValue([]);
  vi.spyOn(desktopApi, 'getNogaCatalog').mockResolvedValue(catalog);
  await diagnosticsApi.clear();
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => { if (root) await reactAct(async () => root!.unmount()); root = undefined; container?.remove(); await setAppLanguage('fr'); expect(externalRequests).toBe(0); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('company VAT identifier consistency', () => {
  it('keeps an onboarding-accepted UID-only registered company ready for billing', () => {
    const value = validSettings();
    expect(validateOnboarding(value, catalog, true, 'complete')).toEqual([]);
    const workspace = { settings: value, accounts: [], accountingSettings: null, backupStatus: { lastSuccessAt: null, lastPath: null, nextScheduledAt: null } } as unknown as Workspace;
    expect(buildSetupReadiness(workspace, value).steps.find(step => step.id === 'billing')).toMatchObject({ ready: true, missing: [] });
  });
  it('submits the real company form with UID only through the button and preserves tax data and captured origin', async () => {
    const form = await openCompany();
    expect(form.checkValidity()).toBe(true);
    await click('Enregistrer l’entreprise');
    await until(() => writes.length === 1);
    expect(writes[0]).toMatchObject({ expectedWorkspaceScope: scope, expectedMemberContextNonce: nonce, data: { uid_number: uid, vat_number: '', vat_registered: true, default_vat_bp: 810, country: 'CH' } });
    expect(publications).toHaveLength(1);
    expect(publications[0].settings?.organization).toMatchObject({ uidNumber: uid, vatNumber: '', vatRegistered: true });
    expect(publications[0].settings?.billing.vatRatesBp).toEqual([810]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(read => read.args.expectedWorkspaceScope === scope && read.args.expectedMemberContextNonce === nonce)).toBe(true);
  });
  it('allows entering UID into an initially empty tax identifier group without requiring a separate VAT field', async () => {
    const value = validSettings(); value.organization.uidNumber = '';
    const form = await openCompany(value);
    await change(form, 'uidNumber', uid);
    expect(form.checkValidity()).toBe(true);
    await click('Enregistrer l’entreprise'); await until(() => writes.length === 1);
    expect(writes[0].data).toMatchObject({ uid_number: uid, vat_number: '', vat_registered: true, default_vat_bp: 810 });
  });
  it.each([{ country: 'CH', vat: `${uid} TVA` }, { country: 'DE', vat: 'DE123456789' }])('keeps the existing VAT-number-only company in $country accepted without rewriting its identifier', async ({ country, vat }) => {
    const value = validSettings(); value.organization.uidNumber = ''; value.organization.vatNumber = vat; value.organization.address.country = country;
    const form = await openCompany(value); expect(form.checkValidity()).toBe(true);
    await click('Enregistrer l’entreprise'); await until(() => writes.length === 1);
    expect(writes[0].data).toMatchObject({ uid_number: '', vat_number: vat, vat_registered: true, default_vat_bp: 810, country });
  });
  it.each(['CH', 'DE'])('still refuses an assujettie company in %s with neither identifier and does not write', async country => {
    const value = validSettings(); value.organization.uidNumber = ''; value.organization.vatNumber = ''; value.organization.address.country = country;
    const form = await openCompany(value);
    // Invoke the actual submit handler too: no reliance on HTML required alone.
    await reactAct(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle();
    expect(writes).toHaveLength(0); expect(publications).toHaveLength(0);
    expect(document.body.textContent).toContain('Renseignez le numéro IDE/UID ou le numéro TVA de l’entreprise.');
    expect(document.querySelector('.notice--error[role="alert"]')?.textContent).toContain('Renseignez le numéro IDE/UID ou le numéro TVA de l’entreprise.');
    expect(settings.organization.vatRegistered).toBe(true); expect(settings.billing.vatRatesBp).toEqual([810]);
  });
  it('still refuses whitespace-only identifiers rather than inventing a VAT identifier', async () => {
    const value = validSettings(); value.organization.uidNumber = '  '; value.organization.vatNumber = '  ';
    const form = await openCompany(value);
    await reactAct(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle();
    expect(writes).toHaveLength(0); expect(publications).toHaveLength(0);
    expect(buildSetupReadiness({ settings: value, accounts: [], accountingSettings: null, backupStatus: {} } as unknown as Workspace, value).steps.find(step => step.id === 'billing')?.ready).toBe(false);
  });
  it('retains the explicit VAT-rate requirement when UID is present', async () => {
    const value = validSettings(); value.billing.vatRatesBp = [];
    const form = await openCompany(value);
    await reactAct(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle();
    expect(writes).toHaveLength(0); expect(publications).toHaveLength(0);
    expect(document.body.textContent).toContain('Ajoutez au moins un taux TVA explicite avant d’enregistrer.');
    expect(settings.organization).toMatchObject({ uidNumber: uid, vatNumber: '', vatRegistered: true });
  });
  it('does not impose either tax identifier or a tax rate on a non-assujettie company', async () => {
    const value = validSettings(); value.organization.uidNumber = ''; value.organization.vatNumber = ''; value.organization.vatRegistered = false; value.billing.vatRatesBp = [];
    const form = await openCompany(value); expect(form.checkValidity()).toBe(true);
    await click('Enregistrer l’entreprise'); await until(() => writes.length === 1);
    expect(writes[0].data).toMatchObject({ uid_number: '', vat_number: '', vat_registered: false, default_vat_bp: 0 });
  });
  it.each([
    { language: 'fr' as const, message: 'Renseignez le numéro IDE/UID ou le numéro TVA de l’entreprise.' },
    { language: 'de' as const, message: 'Geben Sie die UID- oder MWST-Nummer des Unternehmens ein.' },
    { language: 'it' as const, message: 'Inserisci il numero IDI/UID o il numero IVA dell’azienda.' },
    { language: 'en' as const, message: 'Enter the company’s business identification or VAT number.' },
  ])('shows the visible local field correction in $language, focuses UID and permits only the corrected save', async ({ language, message }) => {
    const value = validSettings(); value.organization.uidNumber = '';
    const form = await openCompany(value);
    await reactAct(async () => { await setAppLanguage(language); }); await settle();
    await reactAct(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle();
    expect(writes).toHaveLength(0); expect(publications).toHaveLength(0);
    const notice = document.querySelector('.notice--error[role="alert"]');
    expect(notice?.querySelector('.error-guidance__message p')?.textContent).toBe(message);
    expect(notice?.querySelector('.error-guidance__details')).toBeNull();
    const review = notice?.querySelector<HTMLButtonElement>('.error-guidance__actions button');
    expect(review).not.toBeNull();
    await reactAct(async () => review!.click()); await settle();
    expect(document.activeElement).toBe(form.querySelector('input[name="uidNumber"]'));
    expect(writes).toHaveLength(0); expect(publications).toHaveLength(0);
    await change(form, 'uidNumber', uid);
    await reactAct(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()); await settle();
    await until(() => writes.length === 1);
    expect(writes[0]).toMatchObject({ expectedWorkspaceScope: scope, expectedMemberContextNonce: nonce, data: { uid_number: uid, vat_number: '', vat_registered: true, default_vat_bp: 810 } });
  });
  it.each([
    { language: 'fr' as const, identifier: 'identifiant IDE/UID ou TVA', help: 'Le numéro IDE/UID ou le numéro TVA et au moins un taux explicite sont alors obligatoires.' },
    { language: 'de' as const, identifier: 'UID- oder MWST-Nummer', help: 'Bei MWST-Pflicht sind die UID- oder MWST-Nummer und mindestens ein ausdrücklich festgelegter MWST-Satz erforderlich.' },
    { language: 'it' as const, identifier: 'numero IDI/UID o IVA', help: 'Se l’azienda è soggetta all’IVA, sono obbligatori il numero IDI/UID o il numero IVA e almeno un’aliquota IVA esplicita.' },
    { language: 'en' as const, identifier: 'business identification or VAT number', help: 'If the company is VAT-registered, a business identification or VAT number and at least one explicit VAT rate are required.' },
  ])('displays the two new tax strings in the actual $language context and retains UID-only tax submission', async ({ language, identifier, help }) => {
    const value = validSettings(); value.organization.uidNumber = '';
    const form = await openCompany(value);
    await reactAct(async () => { await setAppLanguage(language); }); await settle();
    expect(document.documentElement.lang).toBe(`${language}-CH`);
    expect(form.querySelector('input[name="vatRegistered"]')?.closest('label')?.querySelector('small')?.textContent?.trim()).toBe(help);
    expect(document.querySelector('.setup-readiness__steps li:nth-child(2) .setup-readiness__copy small')?.textContent).toBe(`À renseigner : ${identifier}.`);
    // The preparation prefix and unrelated old strings intentionally keep their prior rendering.
    expect(writes).toHaveLength(0); expect(publications).toHaveLength(0);
    await change(form, 'uidNumber', uid);
    expect(form.checkValidity()).toBe(true);
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit).not.toBeNull(); await reactAct(async () => submit.click()); await settle();
    await until(() => writes.length === 1);
    expect(writes[0]).toMatchObject({ expectedWorkspaceScope: scope, expectedMemberContextNonce: nonce, data: { uid_number: uid, vat_number: '', vat_registered: true, default_vat_bp: 810 } });
    expect(publications).toHaveLength(1);
    expect(publications[0].settings?.organization).toMatchObject({ uidNumber: uid, vatNumber: '', vatRegistered: true });
    expect(publications[0].settings?.billing.vatRatesBp).toEqual([810]);
  });
});
