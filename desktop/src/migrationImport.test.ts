import { describe, expect, it } from 'vitest';
import { catalogMappingSource, type CatalogMappingSource } from './catalogImport';
import { defaultContactMapping, previewContacts, contactHeaderIndex } from './bexioImport';
import { balanceHeaderIndex, defaultBalanceMapping, defaultOpenInvoiceMapping, previewBalance } from './bexioOpening';
import { chartHeaderIndex, chartImportRows, classFor, defaultChartMapping, natureFromText, previewChart, swissAccountClass } from './chartImport';
import { canUndo, dataImportFromRaw, dataImportKindLabels, importSummary, undoExplanation, undoReportFromRaw } from './dataImports';
import { migrationGuide, migrationKinds, migrationSources, originToRaw, sourceName } from './migrationSources';
import { accountTypeLabels } from './chartImport';
import { translations } from './translations';

const grid = (rows: (string | number)[][], fileName = 'export.xlsx'): CatalogMappingSource => ({
  fileName,
  sheetName: 'Export',
  headerIndex: 0,
  rows: rows.map((row) => row.map((value) => ({ value }))),
});

const textFile = (name: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(0) } as File;
};

describe('contacts from other software', () => {
  it('recognises WinBIZ-style French headers and labels the source in the notes', () => {
    const source = grid([
      ['Liste des adresses'],
      ['Numéro', 'Société', 'Nom', 'Prénom', 'Adresse', 'NPA', 'Localité', 'Pays', 'Téléphone', 'E-mail'],
      ['1001', 'Menuiserie Dubois Sàrl', 'Dubois', 'Anne', 'Rue du Lac 4', '1200', 'Genève', 'CH', '022 000 00 00', 'anne@example.test'],
    ]);
    const header = contactHeaderIndex(source);
    expect(header).toBe(1);
    const mapping = defaultContactMapping(source.rows[header].map((cell) => String(cell.value)));
    expect(mapping).toEqual(['reference', 'company', 'lastName', 'firstName', 'street', 'postalCode', 'city', 'country', 'phone', 'email']);
    const [row] = previewContacts(source, header, mapping, 'clients', [], 'WinBIZ');
    expect(row.data).toMatchObject({ name: 'Menuiserie Dubois Sàrl', contact_person: 'Anne Dubois', city: 'Genève', notes: 'Import WinBIZ · contact 1001' });
    expect(row.errors).toEqual([]);
  });

  it('recognises AbaNinja German headers and Banana address-book names', () => {
    expect(defaultContactMapping(['Kundennummer', 'Firma', 'Vorname', 'Nachname', 'Strasse', 'Hausnummer', 'PLZ', 'Ort', 'E-Mail'])).toEqual([
      'reference', 'company', 'firstName', 'lastName', 'street', 'streetNumber', 'postalCode', 'city', 'email',
    ]);
    expect(defaultContactMapping(['RowId', 'OrganisationName', 'FirstName', 'FamilyName', 'Street', 'PostalCode', 'Locality', 'CountryCode', 'EmailWork'])).toEqual([
      'reference', 'company', 'firstName', 'lastName', 'street', 'postalCode', 'city', 'country', 'email',
    ]);
  });

  it('reads a tab-separated Crésus .txt export', async () => {
    const file = textFile('adresses.txt', 'Société\tNom\tPrénom\tRue\tNPA\tLocalité\r\nGarage Favre SA\tFavre\tLuc\tRoute de Lyon 2\t1203\tGenève\r\n');
    const source = await catalogMappingSource(file);
    expect(source.rows[1].map((cell) => cell.value)).toEqual(['Garage Favre SA', 'Favre', 'Luc', 'Route de Lyon 2', '1203', 'Genève']);
  });
});

describe('open invoices and balances from other software', () => {
  it('maps WinBIZ and AbaNinja invoice headers', () => {
    expect(defaultOpenInvoiceMapping(['N° document', 'Nom du client', 'Date document', 'Échéance', 'Montant TTC', 'Solde dû'])).toEqual(['number', 'client', 'issueDate', 'dueDate', 'total', 'open']);
    expect(defaultOpenInvoiceMapping(['Rechnungsnummer', 'Kunde', 'Datum', 'Fällig am', 'Betrag', 'Offen'])).toEqual(['number', 'client', 'issueDate', 'dueDate', 'total', 'open']);
  });

  it('reads a Banana accounts export as an opening balance', () => {
    const source = grid([
      ['Group', 'Account', 'Description', 'BClass', 'Opening', 'Balance'],
      ['', '1020', 'Banque', '1', '', '12500.50'],
      ['1', '', 'Total actifs', '', '', '12500.50'],
      ['', '2800', 'Capital', '2', '', '12500.50'],
    ]);
    const header = balanceHeaderIndex(source);
    const rows = previewBalance(source, header, defaultBalanceMapping(source.rows[header].map((cell) => String(cell.value))));
    expect(rows.map((row) => [row.code, row.balanceCents])).toEqual([['1020', 1_250_050], ['2800', 1_250_050]]);
  });
});

describe('chart of accounts import', () => {
  it('classifies Swiss SME account numbers', () => {
    expect(swissAccountClass('1020')).toEqual({ accountType: 'asset', normalBalance: 'debit', reportSection: 'current_assets' });
    expect(swissAccountClass('1109')).toMatchObject({ accountType: 'asset', normalBalance: 'credit' });
    expect(swissAccountClass('1500')).toMatchObject({ reportSection: 'fixed_assets' });
    expect(swissAccountClass('2200')).toMatchObject({ accountType: 'liability', reportSection: 'short_term_liabilities' });
    expect(swissAccountClass('2450')).toMatchObject({ reportSection: 'long_term_liabilities' });
    expect(swissAccountClass('2850')).toMatchObject({ accountType: 'equity', normalBalance: 'debit' });
    expect(swissAccountClass('2970')).toMatchObject({ accountType: 'equity', normalBalance: 'credit' });
    expect(swissAccountClass('3200')).toMatchObject({ accountType: 'revenue', reportSection: 'net_revenue' });
    expect(swissAccountClass('5000')).toMatchObject({ reportSection: 'personnel_expense' });
    expect(swissAccountClass('6800')).toMatchObject({ reportSection: 'depreciation' });
    expect(swissAccountClass('6950')).toMatchObject({ accountType: 'revenue', reportSection: 'financial_result' });
    expect(swissAccountClass('7000')).toMatchObject({ accountType: 'revenue', reportSection: 'non_operating_result' });
    expect(swissAccountClass('7010')).toMatchObject({ accountType: 'expense' });
    expect(swissAccountClass('8510')).toMatchObject({ accountType: 'revenue', reportSection: 'exceptional_result' });
    expect(swissAccountClass('8900')).toMatchObject({ accountType: 'expense', reportSection: 'taxes' });
    expect(swissAccountClass('9100')).toBeNull();
    expect(swissAccountClass('10')).toBeNull();
  });

  it('reads Banana BClass and Crésus categories, equity included', () => {
    expect(natureFromText('1', '1020')).toBe('asset');
    expect(natureFromText('2', '2800')).toBe('equity');
    expect(natureFromText('Passif', '2000')).toBe('liability');
    expect(natureFromText('Charge', '6000')).toBe('expense');
    expect(natureFromText('Ertrag', '3000')).toBe('revenue');
    expect(natureFromText('Exploitation', '9000')).toBe('skip');
    expect(classFor('4000', 'revenue')).toEqual({ accountType: 'revenue', normalBalance: 'credit', reportSection: 'net_revenue' });
  });

  it('previews a Crésus chart: groups skipped, existing kept, unknown nature asked', () => {
    const source = grid([
      ['Numéro', 'Titre', 'Catégorie', 'Type'],
      ['1', 'Actifs', 'Actif', 'Groupe'],
      ['1020', 'Banque', 'Actif', 'Normal'],
      ['1025', 'Banque Raiffeisen', 'Actif', 'Normal'],
      ['3400', 'Ventes de prestations', 'Produit', 'Normal'],
      ['AB12', 'Compte libre', '', 'Normal'],
      ['9200', 'Bénéfice', 'Exploitation', 'Normal'],
      ['1025', 'Doublon', 'Actif', 'Normal'],
    ]);
    const header = chartHeaderIndex(source);
    const mapping = defaultChartMapping(source.rows[header].map((cell) => String(cell.value)));
    expect(mapping).toEqual(['code', 'name', 'nature', 'rowType']);
    const rows = previewChart(source, header, mapping, ['1020']);
    expect(rows.map((row) => [row.code, row.skipped])).toEqual([
      ['1', 'Titre ou groupe, pas un compte'],
      ['1020', 'Déjà dans votre plan comptable'],
      ['1025', null],
      ['3400', null],
      ['AB12', 'Titre ou groupe, pas un compte'],
      ['9200', 'Compte de bouclement : Zentra le crée lui-même'],
      ['1025', null],
    ]);
    expect(rows[6].errors).toContain('Compte en double dans le fichier');
    const valid = chartImportRows(rows.slice(0, 6));
    expect(valid).toEqual([
      { line: 4, code: '1025', name: 'Banque Raiffeisen', account_type: 'asset', normal_balance: 'debit', report_section: 'current_assets' },
      { line: 5, code: '3400', name: 'Ventes de prestations', account_type: 'revenue', normal_balance: 'credit', report_section: 'net_revenue' },
    ]);
  });

  it('lets the user choose the nature the file and number do not give', () => {
    const source = grid([['Compte', 'Libellé'], ['10000', 'Caisse principale']]);
    const mapping = defaultChartMapping(['Compte', 'Libellé']);
    expect(previewChart(source, 0, mapping, [])[0].class).toMatchObject({ accountType: 'asset' });
    const odd = grid([['Compte', 'Libellé'], ['99999', 'Inconnu']]);
    expect(previewChart(odd, 0, mapping, [])[0].skipped).toBe('Compte de bouclement : Zentra le crée lui-même');
    const free = grid([['Compte', 'Libellé', 'Nature'], ['0450', 'Compte ancien', '']]);
    const freeMapping = defaultChartMapping(['Compte', 'Libellé', 'Nature']);
    expect(previewChart(free, 0, freeMapping, [])[0].errors).toContain('Nature à choisir');
    const chosen = previewChart(free, 0, freeMapping, [], { 2: 'expense' })[0];
    expect(chosen.errors).toEqual([]);
    expect(chosen.class).toEqual({ accountType: 'expense', normalBalance: 'debit', reportSection: 'other_operating_expense' });
  });
});

describe('import history', () => {
  it('reads the native history and its undo report', () => {
    const entry = dataImportFromRaw({ id: 'a', source: 'winbiz', kind: 'clients', file_name: 'adresses.xlsx', created_count: 12, updated_count: 0, skipped_count: 1, created_at: '2026-10-25T10:00:00Z', undone_at: null, undo_report: null });
    expect(canUndo(entry)).toBe(true);
    expect(importSummary(entry)).toEqual([{ message: '{count} ajouts', count: 12 }, { message: '{count} déjà présent', count: 1 }]);
    const undone = dataImportFromRaw({ ...entry, id: 'b', undone_at: '2026-10-25T11:00:00Z', undo_report: '{"removed":11,"restored":0,"reversed":0,"kept":[{"entity":"clients","id":"x","name":"Beta","reason":"Déjà utilisée dans Zentra"}]}' });
    expect(canUndo(undone)).toBe(false);
    expect(undone.undoReport?.kept[0].name).toBe('Beta');
    expect(undoReportFromRaw('not json')).toBeNull();
    expect(dataImportFromRaw({ source: 'unknown', kind: 'odd' })).toMatchObject({ source: 'generic', kind: 'clients' });
  });

  it('sends the origin without an empty file name', () => {
    expect(originToRaw({ source: 'banana', fileName: '  ' })).toEqual({ source: 'banana' });
    expect(originToRaw({ source: 'cresus', fileName: 'plan.txt' })).toEqual({ source: 'cresus', file_name: 'plan.txt' });
  });
});

it('translates every message the import screens show from data', () => {
  const messages = [
    ...migrationSources.map((entry) => entry.name).filter((name) => !['bexio', 'WinBIZ', 'Crésus', 'Banana'].includes(name)),
    ...migrationKinds.map((entry) => entry.label),
    ...migrationSources.flatMap((source) => migrationKinds.map((kind) => migrationGuide(source.id, kind.id))),
    sourceName('generic'),
    ...Object.values(dataImportKindLabels),
    ...Object.values(accountTypeLabels),
    ...(['clients', 'suppliers', 'catalog', 'accounts', 'opening_receivables', 'opening_balance'] as const).map(undoExplanation),
    ...['{count} compte repris', '{count} comptes repris', '{count} ajout', '{count} ajouts', '{count} mise à jour', '{count} mises à jour', '{count} déjà présent', '{count} déjà présents'],
    'Titre ou groupe, pas un compte', 'Compte de bouclement : Zentra le crée lui-même', 'Déjà dans votre plan comptable',
    'Compte en double dans le fichier', 'Nom du compte manquant ou trop long', 'Nature à choisir',
    'Payée ou annulée', 'Client introuvable : importez d’abord vos clients',
    'Déjà encaissée, rappelée ou liée à un autre document', 'Suivi en stock depuis l’import : prix gardés', 'Déjà utilisée dans Zentra',
    'Catégorie', 'Type de ligne', 'Choisir le plan comptable', 'Choisir le bilan',
  ];
  expect([...new Set(messages)].filter((message) => !translations[message])).toEqual([]);
});
