// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
import './languageTestPacks';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedAssetsPanel } from './FixedAssetsPanel';
import { setAppLanguage, type AppLanguage } from './language';
import type { FixedAssetRow } from './fixedAssets';
import type { Workspace } from './types';
import { fixedAssetsTranslations } from './translationsFixedAssets';
import { translations } from './translations';

const runtime = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false, Channel: class {} }));
vi.mock('./diagnostics', async importOriginal => ({ ...await importOriginal<typeof import('./diagnostics')>(), diagnosticInvoke: runtime.invoke }));
vi.mock('./bridge', () => ({ desktopApi: { listAccounts: vi.fn(), prepareFixedAssetAccounts: vi.fn() } }));
vi.mock('./assistantContext', () => ({ AssistantHelpButton: () => null, useAssistantScreen: () => {} }));

const rawName = 'Acquisition';
const rawReference = 'Référence {date} – facture 客戶';
const rawAccountName = 'Informatique';
const row: FixedAssetRow = {
  asset: { id: 'asset-qa', name: rawName, reference: rawReference, date: '2025-01-15', costCents: 400000, residualCents: 0, rateBp: 2000, method: 'linear', mode: 'reclassify', assetAccountId: 'asset', depreciationAccountId: 'depreciation', counterpartAccountId: 'expense' },
  depreciatedCents: 80000, bookValueCents: 320000, cancelled: false,
  nextYear: 2026, nextAmountCents: 80000, blocker: null,
  history: [{ id: 'history', entry_date: '2025-12-31', amount_cents: 80000 }],
};
const workspace = {
  workNotesScope: 'synthetic-only',
  accounts: [
    { id: 'asset', code: '1500', name: rawAccountName, active: true, accountType: 'asset', normalBalance: 'debit', reportSection: 'fixed_assets' },
    { id: 'depreciation', code: '6800', name: 'Machines', active: true, accountType: 'expense', normalBalance: 'debit', reportSection: 'depreciation' },
    { id: 'expense', code: '4000', name: 'Mobilier', active: true, accountType: 'expense', normalBalance: 'debit', reportSection: 'cost_of_goods' },
  ],
  accountingSettings: { enabled: true, expenseAccountId: 'expense' },
} as unknown as Workspace;
// Independent visible expectations: never derive these labels with t().
const visible = {
  fr: { title: 'Immobilisations', description: 'Vos équipements, leur valeur et leurs amortissements.', add: 'Ajouter un bien', figures: ['Acquisition', 'Amorti', 'Valeur comptable'], history: 'Historique des amortissements', depreciation: 'Amortissement 2026', register: 'Enregistrer un bien', name: 'Nom du bien', reference: 'Référence d’achat', rate: 'Taux annuel, %', save: 'Enregistrer le bien', method: 'Linéaire', acquired: `${rawReference} · acquis le 2025-01-15` },
  de: { title: 'Anlagevermögen', description: 'Ihre Ausstattung, ihr Wert und ihre Abschreibungen.', add: 'Anlage hinzufügen', figures: ['Anschaffung', 'Abgeschrieben', 'Buchwert'], history: 'Abschreibungsverlauf', depreciation: 'Abschreibung 2026', register: 'Anlage erfassen', name: 'Name der Anlage', reference: 'Kaufreferenz', rate: 'Jährlicher Satz, %', save: 'Anlage speichern', method: 'Linear', acquired: `${rawReference} · angeschafft am 2025-01-15` },
  it: { title: 'Immobilizzazioni', description: 'Le vostre attrezzature, il loro valore e i loro ammortamenti.', add: 'Aggiungi un bene', figures: ['Acquisizione', 'Ammortizzato', 'Valore contabile'], history: 'Storico degli ammortamenti', depreciation: 'Ammortamento 2026', register: 'Registra un bene', name: 'Nome del bene', reference: 'Riferimento d’acquisto', rate: 'Tasso annuo, %', save: 'Salva il bene', method: 'Lineare', acquired: `${rawReference} · acquisito il 2025-01-15` },
  en: { title: 'Fixed assets', description: 'Your equipment, its value and depreciation.', add: 'Add an asset', figures: ['Acquisition', 'Depreciated', 'Book value'], history: 'Depreciation history', depreciation: 'Depreciation 2026', register: 'Register an asset', name: 'Asset name', reference: 'Purchase reference', rate: 'Annual rate, %', save: 'Save the asset', method: 'Straight-line', acquired: `${rawReference} · acquired on 2025-01-15` },
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  runtime.invoke.mockImplementation(async command => {
    if (command === 'list_fixed_assets') return { items: structuredClone([row]) };
    throw new Error('Unexpected native mutation in interface test');
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  await act(async () => { await setAppLanguage('fr'); });
  runtime.invoke.mockReset(); vi.unstubAllGlobals();
});
async function render(language: AppLanguage) {
  await act(async () => { await setAppLanguage(language); root.render(<FixedAssetsPanel workspace={workspace} readOnly={false} onChanged={vi.fn(async () => {})} onSetup={vi.fn()} />); });
}
async function click(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text);
  expect(button, text).toBeTruthy(); await act(async () => button!.click());
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('real fixed asset interface in all four languages', () => {
  it.each(['fr', 'de', 'it', 'en'] as const)('renders the register and confirmation in %s without translating user data', async language => {
    await render(language);
    expect(host.querySelector('.fixed-assets__header h2')?.textContent).toBe(visible[language].title);
    expect(host.querySelector('.fixed-assets__header p')?.textContent).toBe(visible[language].description);
    expect([...host.querySelectorAll('dt')].map(node => node.textContent)).toEqual(visible[language].figures);
    expect(host.querySelector('details summary')?.textContent).toBe(visible[language].history);
    expect(host.querySelector('.fixed-assets__identity h3')?.textContent).toBe(rawName);
    expect(host.querySelector('.fixed-assets__identity p')?.textContent).toBe(visible[language].acquired);
    const amount = new Intl.NumberFormat(`${language}-CH`, { style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(800);
    await click(visible[language].depreciation);
    const confirmation = { fr: `Comptabiliser ${amount} au 31.12.2026 ?`, de: `${amount} zum 31.12.2026 buchen?`, it: `Contabilizzare ${amount} al 31.12.2026?`, en: `Record ${amount} on 31.12.2026?` };
    expect(host.querySelector('.fixed-assets__review p')?.textContent).toBe(confirmation[language]);
    expect(runtime.invoke.mock.calls.every(([command]) => command === 'list_fixed_assets')).toBe(true);
    expect(row.asset.name).toBe(rawName); expect(row.asset.reference).toBe(rawReference);
  });

  it.each(['fr', 'de', 'it', 'en'] as const)('renders the source/rate form in %s and retains raw input during a language switch', async language => {
    await render(language); await click(visible[language].add);
    const form = host.querySelector('form')!;
    expect(form.querySelector('h3')?.textContent).toBe(visible[language].register);
    const labels = [...form.querySelectorAll('.field__label')].map(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim());
    expect(labels).toContain(visible[language].name); expect(labels).toContain(visible[language].reference); expect(labels).toContain(visible[language].rate);
    expect(form.querySelector('option[value="linear"]')?.textContent).toBe(visible[language].method);
    expect(form.querySelector('option[value="asset"]')?.textContent).toBe(`1500 · ${rawAccountName}`);
    const inputs = [...form.querySelectorAll<HTMLInputElement>('input')];
    const name = inputs[0], reference = inputs[1], date = inputs[2], cost = inputs[3];
    await fill(name, rawName); await fill(reference, rawReference); await fill(cost, '4000.00');
    const originalDate = date.value;
    const next = language === 'en' ? 'de' : 'en';
    await act(async () => { await setAppLanguage(next); });
    expect(host.querySelector('.fixed-assets__header h2')?.textContent).toBe(visible[next].title);
    expect(form.querySelector('h3')?.textContent).toBe(visible[next].register);
    expect(name.value).toBe(rawName); expect(reference.value).toBe(rawReference); expect(cost.value).toBe('4000.00'); expect(date.value).toBe(originalDate);
    expect(form.querySelector('option[value="asset"]')?.textContent).toBe(`1500 · ${rawAccountName}`);
    expect([...form.querySelectorAll('button')].some(button => button.textContent === visible[next].save)).toBe(true);
    expect(runtime.invoke.mock.calls.every(([command]) => command === 'list_fixed_assets')).toBe(true);
  });

  it('ships every authored fixed-asset key with exactly preserved interpolation parameters', () => {
    const parameters = (text: string) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
    for (const [key, row] of Object.entries(fixedAssetsTranslations)) {
      expect(translations[key], key).toHaveLength(3);
      for (const target of row) expect(parameters(target), key).toEqual(parameters(key));
    }
  });
});
