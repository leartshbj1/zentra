import { describe, expect, it } from 'vitest';
import {
  buildAccountingExport,
  defaultVatCodes,
  detectVat,
  entriesFromJournal,
  exportFileName,
  vatAccountsFrom,
  type ExportEntry,
  type ExportOptions,
} from './accountingExport';
import type { JournalReport } from './types';

const line = (accountId: string, code: string, debitCents: number, creditCents: number, memo = '') => ({ accountId, code, name: code, debitCents, creditCents, memo });
const vatAccounts = { sales: new Set(['a2200']), purchase: new Set(['a1170']) };

// Facture 1000.00 HT à 8,1 % : créance 1081.00, produit 1000.00, TVA 81.00.
const invoice: ExportEntry = { id: 'e1', number: 'J-2026-000001', date: '2026-03-05', description: 'Émission F-1042', lines: [line('a1100', '1100', 108_100, 0, 'Créance client'), line('a3200', '3200', 0, 100_000, 'Produit facturé'), line('a2200', '2200', 0, 8_100, 'TVA due')] };
// Paiement : banque à créance.
const payment: ExportEntry = { id: 'e2', number: 'J-2026-000002', date: '2026-03-20', description: 'Encaissement F-1042', lines: [line('a1020', '1020', 108_100, 0), line('a1100', '1100', 0, 108_100)] };
// Achat à 8,1 % : charge 200.00, impôt préalable 16.20, fournisseur 216.20.
const purchase: ExportEntry = { id: 'e3', number: 'J-2026-000003', date: '2026-03-21', description: 'Facture fournisseur', lines: [line('a4000', '4000', 20_000, 0), line('a1170', '1170', 1_620, 0), line('a2000', '2000', 0, 21_620)] };
// Facture à taux mixtes : 100.00 à 8,1 % + 100.00 à 2,6 % → TVA 10.70.
const mixed: ExportEntry = { id: 'e4', number: 'J-2026-000004', date: '2026-03-22', description: 'Émission F-1043', lines: [line('a1100', '1100', 21_070, 0), line('a3200', '3200', 0, 20_000), line('a2200', '2200', 0, 1_070)] };
const entries = [invoice, payment, purchase, mixed];
const options = (format: ExportOptions['format'], vatMode: ExportOptions['vatMode'] = 'lines', vatCodes: Record<string, string> = defaultVatCodes[format]): ExportOptions => ({ format, vatMode, accountMap: {}, vatCodes, vatAccounts });

describe('VAT detection', () => {
  it('finds the single rate of a simple invoice and purchase', () => {
    expect(detectVat(invoice, vatAccounts)).toEqual({ counterpart: 0, base: 1, vat: 2, rateBp: 810, direction: 'sales' });
    expect(detectVat(purchase, vatAccounts)).toEqual({ counterpart: 2, base: 0, vat: 1, rateBp: 810, direction: 'purchase' });
  });
  it('leaves mixed rates and entries without VAT alone', () => {
    expect(detectVat(mixed, vatAccounts)).toBeNull();
    expect(detectVat(payment, vatAccounts)).toBeNull();
  });
  it('accepts one cent of line rounding and the previous 7.7 % rate', () => {
    const rounded = { ...invoice, lines: [line('a1100', '1100', 1_087, 0), line('a3200', '3200', 0, 1_006), line('a2200', '2200', 0, 81)] };
    expect(detectVat(rounded, vatAccounts)?.rateBp).toBe(810);
    const old = { ...invoice, lines: [line('a1100', '1100', 10_770, 0), line('a3200', '3200', 0, 10_000), line('a2200', '2200', 0, 770)] };
    expect(detectVat(old, vatAccounts)?.rateBp).toBe(770);
  });
});

describe('Banana', () => {
  it('writes the XML column names, one row for a two-line entry and one row per line otherwise', () => {
    const result = buildAccountingExport(entries, options('banana'));
    const rows = result.content.split('\r\n');
    expect(rows[0]).toBe('Date\tDoc\tDescription\tAccountDebit\tAccountCredit\tAmount\tVatCode');
    expect(result.content.startsWith('﻿')).toBe(false);
    expect(rows).toContain('2026-03-20\tJ-2026-000002\tEncaissement F-1042\t1020\t1100\t1081.00\t');
    expect(rows).toContain('2026-03-05\tJ-2026-000001\tÉmission F-1042\t\t2200\t81.00\t');
    expect(result.rows).toBe(1 + 3 + 3 + 3);
  });
  it('lets Banana compute the VAT of single-rate entries in codes mode', () => {
    const result = buildAccountingExport(entries, options('banana', 'codes'));
    const rows = result.content.split('\r\n');
    expect(rows).toContain('2026-03-05\tJ-2026-000001\tÉmission F-1042\t1100\t\t1081.00\t');
    expect(rows).toContain('2026-03-05\tJ-2026-000001\tÉmission F-1042\t\t3200\t1000.00\tV81');
    expect(rows).toContain('2026-03-21\tJ-2026-000003\tFacture fournisseur\t4000\t\t200.00\tM81');
    expect(rows.some((row) => row.includes('\t1170\t'))).toBe(false);
    expect(result.explicitVat).toBe(1);
    expect(result.coded).toBe(2);
    expect(result.vatKeys).toEqual(['purchase:810', 'sales:810']);
  });
  it('keeps the VAT line when no code is known for the rate', () => {
    const result = buildAccountingExport([invoice], options('banana', 'codes', {}));
    expect(result.coded).toBe(0);
    expect(result.content).toContain('\t2200\t81.00\t');
  });
  it('applies the account mapping', () => {
    const result = buildAccountingExport([payment], { ...options('banana'), accountMap: { '1020': '1021', '1100': ' ' } });
    expect(result.content).toContain('\t1021\t1100\t1081.00\t');
  });
});

describe('Crésus', () => {
  it('writes the extended tab text with Swiss dates and multiple entries', () => {
    const result = buildAccountingExport([payment, invoice], options('cresus'));
    const rows = result.content.trimEnd().split('\r\n').map((row) => row.split('\t'));
    expect(rows[0].slice(0, 9)).toEqual(['20.03.2026', '1020', '1100', 'J-2026-000002', 'Encaissement F-1042', '1081.00', '0', '0', '0']);
    expect(rows[0]).toHaveLength(19);
    expect(rows[1].slice(0, 9)).toEqual(['05.03.2026', '1100', '...', 'J-2026-000001', 'Émission F-1042', '1081.00', '0', '0', '1']);
    expect(rows[3].slice(1, 3)).toEqual(['...', '2200']);
  });
  it('links the base and VAT lines with a VAT entry number in codes mode', () => {
    const result = buildAccountingExport([invoice], options('cresus', 'codes', { 'sales:810': 'NOR' }));
    const rows = result.content.trimEnd().split('\r\n').map((row) => row.split('\t'));
    expect(rows.map((row) => row.slice(10, 13))).toEqual([['0', '0', ''], ['1', '1', 'NOR'], ['1', '1', 'NOR']]);
  });
});

describe('Abacus', () => {
  it('writes ASCII entries with account, contra account and D/C', () => {
    const result = buildAccountingExport([payment], options('abacus'));
    const fields = result.content.replace('﻿', '').trimEnd().split(',');
    expect(fields).toHaveLength(50);
    expect(fields.slice(0, 9)).toEqual(['1', 'J', '2026-03-20', '1020', '1100', 'Encaissement F-1042', '1081.00', '', 'D']);
    expect(fields[23]).toBe('CHF');
  });
  it('carries the VAT in one record for a single-rate entry', () => {
    const result = buildAccountingExport([invoice, purchase], options('abacus', 'codes', { 'sales:810': '311', 'purchase:810': '111' }));
    const [sale, cost] = result.content.replace('﻿', '').trimEnd().split('\r\n').map((row) => row.split(','));
    expect([sale[3], sale[4], sale[6], sale[35], sale[36], sale[37], sale[41], sale[43], sale[44], sale[49]]).toEqual(['1100', '3200', '1081.00', '311', '8.10', 'I', '2200', '2', '81.00', '1']);
    expect([cost[3], cost[4], cost[6], cost[41], cost[43], cost[49]]).toEqual(['4000', '2000', '216.20', '1170', '1', '2']);
  });
});

describe('WinBIZ and standard CSV', () => {
  it('writes one row per movement with a BOM and semicolons', () => {
    const result = buildAccountingExport([payment, invoice], options('csv'));
    const rows = result.content.replace('﻿', '').trimEnd().split('\r\n');
    expect(result.content.startsWith('﻿')).toBe(true);
    expect(rows[0]).toBe('Date;Pièce;Compte débit;Compte crédit;Libellé;Montant CHF;Code TVA;Taux TVA;Montant TVA');
    expect(rows[1]).toBe('2026-03-20;J-2026-000002;1020;1100;Encaissement F-1042;1081.00;;;');
    expect(rows[3]).toBe('2026-03-05;J-2026-000001;;3200;Émission F-1042 · Produit facturé;1000.00;;;');
  });
  it('annotates the base line with code, rate and VAT amount, keeping the VAT line', () => {
    const result = buildAccountingExport([invoice], options('winbiz', 'codes', { 'sales:810': '81' }));
    const rows = result.content.replace('﻿', '').trimEnd().split('\r\n');
    expect(rows[2]).toBe('05.03.2026;J-2026-000001;;3200;Émission F-1042 · Produit facturé;1000.00;81;8.10;81.00');
    expect(rows).toHaveLength(4);
  });
  it('neutralises spreadsheet formulas in text', () => {
    const risky = { ...payment, description: '=HYPERLINK("x")' };
    expect(buildAccountingExport([risky], options('csv')).content).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

it('reads the journal, names the file and finds the VAT accounts', () => {
  const report = {
    entries: [{ id: 'e2', number: 'J-2', entryDate: '2026-03-20', description: 'Encaissement', sourceType: 'payment', sourceId: 'p', sourceEvent: 'post', status: 'posted', reversalOf: null, hasReversal: false }],
    lines: [
      { id: 'l1', journalEntryId: 'e2', accountId: 'a1020', accountCode: '1020', accountName: 'Banque', entryNumber: 'J-2', entryDate: '2026-03-20', debitCents: 500, creditCents: 0, currency: 'CHF', memo: '', projectId: null, clientId: null, employeeId: null },
      { id: 'l2', journalEntryId: 'e2', accountId: 'a1100', accountCode: '1100', accountName: 'Clients', entryNumber: 'J-2', entryDate: '2026-03-20', debitCents: 0, creditCents: 500, currency: 'CHF', memo: '', projectId: null, clientId: null, employeeId: null },
    ],
    currency: { baseCurrency: 'CHF' },
  } as unknown as JournalReport;
  expect(entriesFromJournal(report)).toEqual([{ id: 'e2', number: 'J-2', date: '2026-03-20', description: 'Encaissement', lines: [line('a1020', '1020', 500, 0), line('a1100', '1100', 0, 500)].map((item, index) => ({ ...item, name: index ? 'Clients' : 'Banque' })) }]);
  expect(exportFileName('banana', '2026-01-01', '2026-12-31')).toBe('Zentra-ecritures-banana-2026-01-01-2026-12-31.txt');
  const accounts = vatAccountsFrom([{ id: 'x2200', code: '2200' }, { id: 'x1171', code: '1171' }, { id: 'x1176', code: '1176' }, { id: 'x2206', code: '2206' }], { vatPayableAccountId: 'p', vatReceivableAccountId: 'r' });
  expect([...accounts.sales].sort()).toEqual(['p', 'x2200']);
  expect([...accounts.purchase].sort()).toEqual(['r', 'x1171']);
});
