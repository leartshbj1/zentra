import { describe, it, expect } from 'vitest';
import { Workbook } from 'exceljs';
import {
  defaultContactMapping,
  previewContacts,
  contactHeaderIndex,
} from './bexioImport';
import {
  catalogMappingSource,
  type CatalogMappingSource,
} from './catalogImport';
const source = (rows: (string | number)[][]): CatalogMappingSource => ({
  fileName: 'bexio.xlsx',
  sheetName: 'Contacts',
  headerIndex: 0,
  rows: rows.map((row) => row.map((value) => ({ value }))),
});
describe('bexio export contacts', () => {
  it('preserves Excel zero masks for contact references and postal codes', async () => {
    const book = new Workbook();
    const sheet = book.addWorksheet('Contacts');
    const headers = ['Nº du contact', 'Entreprise', 'NPA'];
    sheet.addRow(headers);
    sheet.addRow([42, 'Énergie Démo SA', 123]);
    sheet.getCell('A2').numFmt = '00000';
    sheet.getCell('C2').numFmt = '0000';
    const bytes = new Uint8Array(await book.xlsx.writeBuffer());
    const data = await catalogMappingSource({name:'contacts.xlsx',size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)} as File);
    const row = previewContacts(data, 0, defaultContactMapping(headers), 'clients', [])[0];
    expect(row.data).toMatchObject({name:'Énergie Démo SA',postal_code:'0123',notes:'Import bexio · contact 00042'});
  });
  it('maps official French headers and keeps the target explicit', () => {
    const headers = [
      'Nº du contact',
      'Entreprise',
      'Nom',
      'Prénom',
      'Rue',
      'Numéro de rue',
      'NPA',
      'Ville',
      'E-mail',
      'Catégorie',
    ];
    const data = source([
      headers,
      [
        '001',
        'Entreprise exemple SA',
        'Martin',
        'Léa',
        'Rue Exemple',
        '12',
        '0123',
        'Genève',
        'lea@example.com',
        'Fournisseur;Clients',
      ],
    ]);
    const rows = previewContacts(
      data,
      0,
      defaultContactMapping(headers),
      'clients',
      [],
    );
    expect(rows[0].data).toMatchObject({
      name: 'Entreprise exemple SA',
      contact_person: 'Léa Martin',
      postal_code: '0123',
      address_line1: 'Rue Exemple 12',
      notes: 'Import bexio · contact 001',
    });
    expect(rows[0].errors).toEqual([]);
    expect(
      previewContacts(
        data,
        0,
        defaultContactMapping(headers),
        'suppliers',
        [],
      )[0].data,
    ).toMatchObject({
      name: 'Entreprise exemple SA',
      contact_name: 'Léa Martin',
      address: 'Rue Exemple 12\n0123 Genève',
    });
  });
  it('prioritizes main addresses and leaves same-name records untouched', () => {
    const headers = ['Entreprise', 'Rue', 'Adresse principale'];
    const data = source([
      headers,
      ['Exemple SA', 'Secondaire', '0'],
      ['Exemple SA', 'Principale', '1'],
    ]);
    const rows = previewContacts(
      data,
      0,
      defaultContactMapping(headers),
      'clients',
      [],
    );
    expect(rows[0].line).toBe(3);
    expect(rows[0].data.address_line1).toBe('Principale');
    expect(rows[1].duplicate).toBe(true);
    expect(
      previewContacts(data, 0, defaultContactMapping(headers), 'clients', [
        '  exemple sa  ',
      ]).every((row) => row.duplicate),
    ).toBe(true);
  });
  it('blocks duplicate mappings, malformed email and oversized files', async () => {
    const data = source([
      ['Nom', 'E-mail'],
      ['Martin', 'invalid'],
    ]);
    expect(
      previewContacts(data, 0, ['lastName', 'email'], 'clients', [])[0].errors,
    ).toContain('E-mail à corriger');
    expect(() =>
      previewContacts(data, 0, ['lastName', 'lastName'], 'clients', []),
    ).toThrow('une seule');
    expect(() =>
      previewContacts(data, 0, ['ignore', 'email'], 'clients', []),
    ).toThrow('Entreprise ou Nom');
    await expect(
      catalogMappingSource({
        name: 'export.csv',
        size: 21 * 1024 * 1024,
      } as File),
    ).rejects.toThrow('20 Mo');
  });
  it('reads quoted CSV accents, semicolons and line breaks', async () => {
    const data = await catalogMappingSource({
      name: 'export.csv',
      size: 200,
      text: async () =>
        '\uFEFFEntreprise;E-mail;Notes\r\n"Électricité; Démo";demo@example.com;"Deux\nlignes"',
    } as File);
    const rows = previewContacts(
      data,
      contactHeaderIndex(data),
      defaultContactMapping(['Entreprise', 'E-mail', 'Notes']),
      'clients',
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Électricité; Démo');
    expect(rows[0].data.notes).toContain('Deux\nlignes');
  });
});
