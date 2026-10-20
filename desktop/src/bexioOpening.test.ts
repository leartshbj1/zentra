import { describe, expect, it } from 'vitest';
import type { CatalogMappingSource } from './catalogImport';
import {
  amountCents,
  balanceHeaderIndex,
  closedStatus,
  defaultBalanceMapping,
  defaultOpenInvoiceMapping,
  isoDate,
  openingBalanceLines,
  openingReceivableRows,
  openInvoiceHeaderIndex,
  previewBalance,
  previewOpenInvoices,
} from './bexioOpening';
import type { Client } from './types';

const source = (rows: unknown[][]): CatalogMappingSource => ({
  fileName: 'bexio.xlsx',
  sheetName: 'Export',
  headerIndex: 0,
  rows: rows.map((row) => row.map((value) => ({ value }))),
});

const client = (id: string, name: string, address = true): Client => ({
  id, name, company: name, email: '', phone: '', address: '', uidNumber: '', notes: '',
  ...(address ? { addressLine1: 'Bahnhofstrasse 1', postalCode: '8001', city: 'Zürich' } : {}),
});

describe('montants et dates des exports bexio', () => {
  it('reads Swiss, French and accounting amount formats', () => {
    expect(amountCents("1'234.50")).toBe(123_450);
    expect(amountCents('1 234,50 CHF')).toBe(123_450);
    expect(amountCents('CHF 80.-')).toBe(8_000);
    expect(amountCents('-80.00')).toBe(-8_000);
    expect(amountCents('(250.00)')).toBe(-25_000);
    expect(amountCents('1,234')).toBe(123_400);
    expect(amountCents('12,5')).toBe(1_250);
    expect(amountCents(949.77)).toBe(94_977);
    expect(amountCents('EUR 10')).toBeNull();
    expect(amountCents('')).toBeNull();
  });
  it('reads Excel dates, serial numbers and Swiss text dates', () => {
    expect(isoDate({ value: new Date(Date.UTC(2025, 11, 31)) })).toBe('2025-12-31');
    expect(isoDate({ value: 46022 })).toBe('2025-12-31');
    expect(isoDate('31.12.2025')).toBe('2025-12-31');
    expect(isoDate('1/2/26')).toBe('2026-02-01');
    expect(isoDate('2026-02-30')).toBeNull();
    expect(isoDate('demain')).toBeNull();
  });
  it('keeps partially paid invoices open', () => {
    expect(closedStatus('Payée')).toBe(true);
    expect(closedStatus('Bezahlt')).toBe(true);
    expect(closedStatus('Storniert')).toBe(true);
    expect(closedStatus('Partiellement payée')).toBe(false);
    expect(closedStatus('Teilweise bezahlt')).toBe(false);
    expect(closedStatus('Ouverte')).toBe(false);
    expect(closedStatus('')).toBe(false);
  });
});

describe('factures ouvertes bexio', () => {
  const headers = ['N°', 'Contact', 'Titre', 'Date', 'Échéance', 'Total', 'Ouvert', 'Statut'];
  const data = source([
    ['Liste des factures'],
    headers,
    ['RE-00041', 'Muster AG', 'Site web', '10.12.2025', '09.01.2026', "1'250.50", "1'250.50", 'Ouverte'],
    ['RE-00042', 'Muster AG', 'Maintenance', '15.12.2025', '14.01.2026', '1000.00', '400.00', 'Partiellement payée'],
    ['RE-00043', 'Muster AG', 'Ancienne', '01.11.2025', '01.12.2025', '300.00', '0.00', 'Payée'],
    ['RE-00044', 'Inconnu Sàrl', 'Conseil', '20.12.2025', '', '500.00', '500.00', 'Ouverte'],
    ['RE-00045', 'Sans Adresse SA', 'Conseil', '20.12.2025', '19.01.2026', '200.00', '200.00', 'Ouverte'],
    ['RE-00041', 'Muster AG', 'Doublon', '10.12.2025', '09.01.2026', '10.00', '10.00', 'Ouverte'],
    ['F-2026-001', 'Muster AG', 'Déjà là', '05.01.2026', '04.02.2026', '90.00', '90.00', 'Ouverte'],
  ]);
  const clients = [client('c1', 'Muster AG'), client('c2', 'Sans Adresse SA', false)];

  it('finds the header and maps French bexio columns', () => {
    const header = openInvoiceHeaderIndex(data);
    expect(header).toBe(1);
    expect(defaultOpenInvoiceMapping(headers)).toEqual(['number', 'client', 'title', 'issueDate', 'dueDate', 'total', 'open', 'status']);
    expect(defaultOpenInvoiceMapping(['Nr.', 'Kontakt', 'Titel', 'Datum', 'Fällig am', 'Total', 'Offen', 'Status'])).toEqual(['number', 'client', 'title', 'issueDate', 'dueDate', 'total', 'open', 'status']);
  });

  it('keeps only what is still owed, matched to an existing client', () => {
    const rows = previewOpenInvoices(data, 1, defaultOpenInvoiceMapping(headers), clients, ['F-2026-001'], 30);
    const by = (line: number) => rows.find((row) => row.line === line)!;
    expect(by(3)).toMatchObject({ number: 'RE-00041', clientId: 'c1', issueDate: '2025-12-10', dueDate: '2026-01-09', openCents: 125_050, errors: [], skipped: null });
    expect(by(4)).toMatchObject({ openCents: 40_000, totalCents: 100_000, errors: [] });
    expect(by(5).skipped).toBe('Payée ou annulée dans bexio');
    expect(by(6).errors).toContain('Client introuvable : importez d’abord vos clients bexio');
    // Échéance absente : délai de paiement de l'entreprise.
    expect(by(6).dueDate).toBe('2026-01-19');
    expect(by(7).errors).toEqual(['Adresse du client à compléter']);
    expect(by(8).errors).toContain('Facture en double dans le fichier');
    expect(by(9).skipped).toBe('Déjà dans Zentra');
    const native = openingReceivableRows(rows);
    expect(native.map((row) => row.number)).toEqual(['RE-00041', 'RE-00042']);
    expect(native[1]).toEqual({ line: 4, number: 'RE-00042', client_id: 'c1', issue_date: '2025-12-15', due_date: '2026-01-14', open_cents: 40_000, total_cents: 100_000, title: 'Maintenance' });
  });

  it('asks for the columns it cannot guess', () => {
    expect(() => previewOpenInvoices(data, 1, ['number', 'ignore', 'ignore', 'issueDate', 'ignore', 'total', 'ignore', 'ignore'], clients, [])).toThrow('Client');
    expect(() => previewOpenInvoices(data, 1, ['number', 'client', 'ignore', 'issueDate', 'ignore', 'ignore', 'ignore', 'ignore'], clients, [])).toThrow('Montant ouvert');
  });
});

describe('bilan d’ouverture bexio', () => {
  it('reads account balances and skips title and total lines', () => {
    const data = source([
      ['Bilan au 31.12.2025'],
      ['Compte', 'Libellé', 'Solde'],
      ['', 'Actifs', ''],
      ['1020', 'Banque', "45'000.00"],
      ['1100', 'Créances clients', '12 400,00'],
      ['', 'Total actifs', "57'400.00"],
      ['2000', 'Fournisseurs', '7400.00'],
      ['2800', 'Capital', '50000'],
      ['2970', 'Bénéfice reporté', '0.00'],
    ]);
    const header = balanceHeaderIndex(data);
    expect(header).toBe(1);
    const rows = previewBalance(data, header, defaultBalanceMapping(['Compte', 'Libellé', 'Solde']));
    expect(rows.map((row) => [row.code, row.balanceCents])).toEqual([['1020', 4_500_000], ['1100', 1_240_000], ['2000', 740_000], ['2800', 5_000_000], ['2970', 0]]);
    // Les soldes nuls ne sont pas envoyés.
    expect(openingBalanceLines(rows).map((line) => line.code)).toEqual(['1020', '1100', '2000', '2800']);
    expect(openingBalanceLines(rows)[0]).toEqual({ line: 4, code: '1020', name: 'Banque', balance_cents: 4_500_000 });
  });

  it('reads debit and credit columns as exported', () => {
    const headers = ['Konto', 'Bezeichnung', 'Soll', 'Haben'];
    expect(defaultBalanceMapping(headers)).toEqual(['code', 'name', 'debit', 'credit']);
    const rows = previewBalance(source([headers, ['1020', 'Bank', '1000.00', ''], ['2000', 'Kreditoren', '', '250.00'], ['1020', 'Bank', '1', '']]), 0, defaultBalanceMapping(headers));
    expect(rows[1]).toMatchObject({ code: '2000', debitCents: 0, creditCents: 25_000 });
    expect(rows[0].errors).toEqual(['Compte en double']);
    expect(openingBalanceLines(rows)).toEqual([{ line: 3, code: '2000', name: 'Kreditoren', debit_cents: 0, credit_cents: 25_000 }]);
  });
});
