import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { translations } from './translations';
import { purchaseTranslations } from './translationsPurchases';
import { appLanguages, setAppLanguage, t } from './language';
import { purchaseIssueText, purchaseNativeMessage } from './purchaseLanguage';
import { newPurchaseLine, purchaseFields, purchaseIssue, purchaseLineValue } from './supplierInvoicePreparation';
import type { Workspace } from './types';

afterEach(() => setAppLanguage('fr'));

it('covers every supplier preparation message and preserves placeholder names in all languages', () => {
  const keys = new Set<string>(), rawText: string[] = [];
  for (const file of ['SupplierInvoiceWizard.tsx', 'SupplierInvoiceAttachments.tsx', 'supplierInvoicePreparation.ts', 'purchaseLanguage.ts', 'purchaseVat.ts']) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxText(node) && /[A-Za-zÀ-ÿ]/.test(node.text)) rawText.push(node.text.trim());
      if (ts.isStringLiteral(node) && node.text !== 'input, textarea, select' &&
        ((/^[A-Za-zÀ-ÿ]/.test(node.text.trim()) && /[\sÀ-ÿ]/.test(node.text)) || (ts.isCallExpression(node.parent) && node.parent.expression.getText(ast) === 't')) &&
        !(ts.isJsxAttribute(node.parent) && ['className', 'name', 'aria-labelledby'].includes(node.parent.name.getText(ast)))) keys.add(node.text.trim());
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  for (const key of ['Facture', 'Achats', 'Vérifier', 'Justificatif', 'Projet']) keys.add(key);
  expect(keys.size).toBeGreaterThan(130);
  expect([...keys].filter(key => !translations[key])).toEqual([]);
  expect(rawText).toEqual([]);
  for (const [key, entries] of Object.entries(purchaseTranslations)) for (const entry of entries) {
    expect(entry.trim().length).toBeGreaterThan(0);
    expect([...entry.matchAll(/\{\w+\}/g)].map(match => match[0]).sort(), key).toEqual([...key.matchAll(/\{\w+\}/g)].map(match => match[0]).sort());
  }
});

const workspace = { settings: { organization: { vatRegistered: true }, billing: { paymentTermsDays: 30, vatRatesBp: [810] }, work: { costCategories: ['Catégorie {number}'] } }, suppliers: [{ id: 'supplier', name: 'Fournisseur {message}', paymentTermsDays: 30, archivedAt: null }] } as unknown as Workspace;

it('retranslates an existing field error and its line number without recreating or changing the draft', () => {
  const fields = purchaseFields(workspace, undefined, '2026-09-05');
  Object.assign(fields.lines[0], { description: 'Description {message}', quantity: '1,0001', price: '12,50' });
  const before = JSON.stringify(fields), issue = purchaseIssue(fields, [810])!;
  expect(issue.field).toContain('quantity'); expect(issue.line).toBe(1);
  for (const language of appLanguages) {
    setAppLanguage(language);
    expect(purchaseIssueText(issue)).toBe(t('Ligne {number} : {message}', { number: 1, message: t(issue.message) }));
    if (language !== 'fr') expect(purchaseIssueText(issue)).not.toContain('indiquez une quantité');
    expect(JSON.stringify(fields)).toBe(before);
  }
});

it('creates a default unit in the selected language and preserves saved business text after a switch', () => {
  for (const language of appLanguages) {
    setAppLanguage(language);
    const line = newPurchaseLine(workspace);
    expect(line.unit).toBe(t('unité'));
    Object.assign(line, { description: 'TVA {name}', price: '100,10', quantity: '2,5', discount: '10' });
    const expected = purchaseLineValue(line);
    setAppLanguage(language === 'de' ? 'it' : 'de');
    expect(purchaseLineValue(line)).toEqual(expected);
    expect(line.category).toBe('Catégorie {number}');
    expect(t('Supprimer le justificatif « {name} » ?', { name: 'Facture {name}.pdf' })).toContain('Facture {name}.pdf');
  }
});

it('gives translated native guidance while keeping unknown responses out of the primary message', () => {
  const fallback = 'Le brouillon n’a pas pu être enregistré. Votre saisie est conservée.';
  for (const language of ['de', 'it', 'en'] as const) {
    const closed = purchaseNativeMessage('Champs invalides : la période comptable est fermée.', fallback, language);
    expect(closed).toBe(t('La date de cette facture appartient à une période comptable fermée. Vérifiez la date ou consultez Comptabilité → Exercices avant de réessayer.', undefined, language));
    expect(purchaseNativeMessage('Unrecognised storage failure: {name}', fallback, language)).toBe(t(fallback, undefined, language));
    expect(purchaseNativeMessage('Ouverture impossible', 'Le justificatif local n’a pas pu être ouvert.', language)).toBe(t('Le justificatif local n’a pas pu être ouvert.', undefined, language));
    expect(purchaseNativeMessage('Suppression impossible', 'Le justificatif n’a pas pu être supprimé.', language)).toBe(t('Le justificatif n’a pas pu être supprimé.', undefined, language));
  }
  expect(purchaseNativeMessage('Cause native précise', fallback, 'fr')).toBe('Cause native précise');
});
