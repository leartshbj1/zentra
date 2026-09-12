import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountingMappingFields, accountingMappingIssues, accountingRequirementsFromRaw } from './accountingSetup';
import type { Account, AccountingSettings } from './types';
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: invokeMock }));
import { desktopApi } from './bridge';
afterEach(() => invokeMock.mockReset());

function example() {
  const fields = accountingMappingFields({ payroll: true, deferredVat: true }, false);
  const accounts = fields.map((field, i) => ({ id: field.key, code: String(1000 + i), name: field.label, accountType: field.type, active: true, normalBalance: 'debit', reportSection: 'current_assets' })) as Account[];
  const settings = Object.fromEntries([['enabled', true], ...fields.map(field => [field.key, field.key])]) as AccountingSettings;
  return { fields, accounts, settings };
}

describe('configuration guidée des comptes', () => {
  it.each([[false, false, 7], [false, true, 8], [true, false, 11], [true, true, 12]])('suit les exigences natives paie=%s et TVA reçue=%s : %s comptes', (payroll, deferredVat, count) => {
    const fields = accountingMappingFields({ payroll: Boolean(payroll), deferredVat: Boolean(deferredVat) }, !payroll);
    expect(fields.filter(field => field.required)).toHaveLength(Number(count));
    expect(fields.some(field => field.group === 'payroll')).toBe(Boolean(payroll));
  });
  it('garde une vérification prudente avec un ancien moteur', () => {
    expect(accountingMappingFields(undefined, true).filter(field => field.required)).toHaveLength(12);
    expect(accountingMappingFields(undefined, false).filter(field => field.required)).toHaveLength(8);
    for (const value of [null, {}, { payroll: false }, { payroll: 0, deferred_vat: false }, { payroll: false, deferred_vat: 'false' }]) expect(accountingRequirementsFromRaw(value)).toBeUndefined();
  });
  it('transmet les deux exigences du rapport natif sans déduire les valeurs absentes', async () => {
    invokeMock.mockResolvedValue({ mapping_requirements: { payroll: false, deferred_vat: true } });
    expect((await desktopApi.getAccountingContinuity()).mappingRequirements).toEqual({ payroll: false, deferredVat: true });
    invokeMock.mockResolvedValue({});
    expect((await desktopApi.getAccountingContinuity()).mappingRequirements).toBeUndefined();
  });
  it('accepte sept comptes sans TVA différée et conserve les choix pendant la validation', () => {
    const { settings, accounts } = example();
    settings.vatDeferredPayableAccountId = '';
    const original = structuredClone(settings);
    expect(accountingMappingIssues(settings, accounts, accountingMappingFields({ payroll: false, deferredVat: false }, false))).toEqual([]);
    expect(settings).toEqual(original);
  });
  it.each(['inactive', 'missing', 'wrongType'])('explique le compte %s au champ concerné', state => {
    const { settings, accounts, fields } = example();
    if (state === 'inactive') accounts[0].active = false;
    if (state === 'missing') accounts.shift();
    if (state === 'wrongType') accounts[0].accountType = 'expense';
    expect(accountingMappingIssues(settings, accounts, fields)).toEqual([{ key: 'arAccountId', message: expect.stringContaining('Factures clients à encaisser') }]);
  });
  it('vérifie aussi la TVA différée facultative lorsqu’un compte est sélectionné', () => {
    const { settings, accounts } = example();
    settings.vatDeferredPayableAccountId = settings.bankAccountId;
    expect(accountingMappingIssues(settings, accounts, accountingMappingFields({ payroll: false, deferredVat: false }, false))).toEqual([{ key: 'vatDeferredPayableAccountId', message: expect.stringContaining('bon type') }]);
  });
  it.each([['arAccountId', 'bankAccountId'], ['arAccountId', 'vatReceivableAccountId'], ['bankAccountId', 'vatReceivableAccountId'], ['vatPayableAccountId', 'vatDeferredPayableAccountId']] as const)('refuse le même compte pour %s et %s', (first, second) => {
    const { settings, accounts, fields } = example();
    settings[second] = settings[first];
    expect(accountingMappingIssues(settings, accounts, fields)).toEqual([{ key: second, message: expect.stringContaining('deux comptes différents') }]);
  });
  it('autorise la désactivation sans exiger des comptes inutilisés', () => {
    const { settings, accounts, fields } = example();
    settings.enabled = false; settings.arAccountId = '';
    expect(accountingMappingIssues(settings, accounts, fields)).toEqual([]);
    settings.enabled = true;
    expect(accountingMappingIssues(settings, accounts, fields)).toEqual([{ key: 'arAccountId', message: expect.stringContaining('Choisissez') }]);
  });
});
