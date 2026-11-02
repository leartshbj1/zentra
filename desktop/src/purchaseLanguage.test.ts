import './languageTestPacks';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { translations } from './translations';
import { purchaseTranslations } from './translationsPurchases';
import { appLanguages, setAppLanguage, t } from './language';
import { purchaseIssueText } from './purchaseLanguage';
import { newPurchaseLine, purchaseFields, purchaseIssue, purchaseLineValue } from './supplierInvoicePreparation';
import type { Workspace } from './types';

afterEach(async () => await setAppLanguage('fr'));

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

it('retranslates an existing field error and its line number without recreating or changing the draft', async () => {
  const fields = purchaseFields(workspace, undefined, '2026-09-05');
  Object.assign(fields.lines[0], { description: 'Description {message}', quantity: '1,0001', price: '12,50' });
  const before = JSON.stringify(fields), issue = purchaseIssue(fields, [810])!;
  expect(issue.field).toContain('quantity'); expect(issue.line).toBe(1);
  for (const language of appLanguages) {
    await setAppLanguage(language);
    expect(purchaseIssueText(issue)).toBe(t('Ligne {number} : {message}', { number: 1, message: t(issue.message) }));
    if (language !== 'fr') expect(purchaseIssueText(issue)).not.toContain('indiquez une quantité');
    expect(JSON.stringify(fields)).toBe(before);
  }
});

it('creates a default unit in the selected language and preserves saved business text after a switch', async () => {
  for (const language of appLanguages) {
    await setAppLanguage(language);
    const line = newPurchaseLine(workspace);
    expect(line.unit).toBe(t('unité'));
    Object.assign(line, { description: 'TVA {name}', price: '100,10', quantity: '2,5', discount: '10' });
    const expected = purchaseLineValue(line);
    await setAppLanguage(language === 'de' ? 'it' : 'de');
    expect(purchaseLineValue(line)).toEqual(expected);
    expect(line.category).toBe('Catégorie {number}');
    expect(t('Supprimer le justificatif « {name} » ?', { name: 'Facture {name}.pdf' })).toContain('Facture {name}.pdf');
  }
});

